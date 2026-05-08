use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{self, Command};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::{
    bind::Binder,
    daemon,
    model::{AppError, Instance, InstanceStatus, PtySession},
    pty::PtyManager,
    swarm::swarm_db_path,
    writes,
};

const PRICE_CATALOG_JSON: &str = include_str!("price_catalog.json");
const KILL_GRACE_MS: u64 = 1000;
const AGENT_SCOPE_WINDOW_SECS: i64 = 900;
const EXTERNAL_RSS_THRESHOLD_KB: i64 = 100_000;
const EXTERNAL_CPU_THRESHOLD: f64 = 1.0;
const EXTERNAL_LIMIT: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageConfidence {
    Exact,
    Estimated,
    Unlinked,
    Na,
}

impl UsageConfidence {
    #[must_use]
    pub const fn unlinked() -> Self {
        Self::Unlinked
    }

    #[must_use]
    pub const fn na() -> Self {
        Self::Na
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KillTarget {
    BoundInstance { instance_id: String },
    OrphanPtySession { pty_id: String },
    TerminalProcessGroup { pgid: i32, root_pid: Option<i32> },
    DetachedMcpProcessSet { pids: Vec<i32>, label: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UsageAttribution {
    pub source_kind: String,
    pub source_ref: Option<String>,
    pub session_id: Option<String>,
    pub thread_id: Option<String>,
    pub link_basis: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSessionRow {
    pub session_key: String,
    pub session_kind: String,
    pub session_label: String,
    pub root_pid: Option<i32>,
    pub process_group_id: Option<i32>,
    pub child_pids: Vec<i32>,
    pub tty: Option<String>,
    pub pty_id: Option<String>,
    pub instance_id: Option<String>,
    pub scope: Option<String>,
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub harness: Option<String>,
    pub model: Option<String>,
    pub started_at: Option<i64>,
    pub elapsed_seconds: Option<i64>,
    pub cpu_percent: f64,
    pub rss_kb: i64,
    pub status: String,
    pub activity: String,
    pub helper_count: usize,
    #[serde(rename = "tokensExact")]
    pub tokens_exact: Option<i64>,
    #[serde(rename = "tokensEstimated")]
    pub tokens_estimated: Option<i64>,
    #[serde(rename = "costExactUsd")]
    pub cost_exact_usd: Option<f64>,
    #[serde(rename = "costEstimatedUsd")]
    pub cost_estimated_usd: Option<f64>,
    #[serde(rename = "usageConfidence")]
    pub usage_confidence: UsageConfidence,
    #[serde(rename = "costConfidence")]
    pub cost_confidence: UsageConfidence,
    #[serde(rename = "usageAttribution")]
    pub usage_attribution: Option<UsageAttribution>,
    pub killable: bool,
    #[serde(rename = "killProtectionReason")]
    pub kill_protection_reason: Option<String>,
    #[serde(rename = "killTarget")]
    pub kill_target: KillTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HelperProcessRow {
    pub helper_key: String,
    pub helper_kind: String,
    pub label: String,
    pub pid: i32,
    pub pids: Vec<i32>,
    pub parent_session_key: Option<String>,
    pub tty: Option<String>,
    pub scope: Option<String>,
    pub command: String,
    pub started_at: i64,
    pub elapsed_seconds: i64,
    pub cpu_percent: f64,
    pub rss_kb: i64,
    pub killable: bool,
    #[serde(rename = "killProtectionReason")]
    pub kill_protection_reason: Option<String>,
    #[serde(rename = "killTarget")]
    pub kill_target: Option<KillTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalProcessRow {
    pub external_key: String,
    pub label: String,
    pub pid: i32,
    pub process_group_id: i32,
    pub tty: Option<String>,
    pub command: String,
    pub started_at: i64,
    pub elapsed_seconds: i64,
    pub cpu_percent: f64,
    pub rss_kb: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DaemonProcessRow {
    pub daemon_key: String,
    pub daemon_kind: String,
    pub label: String,
    pub pid: i32,
    pub parent_pid: i32,
    pub parent_label: Option<String>,
    pub process_group_id: i32,
    pub command: String,
    pub started_at: i64,
    pub elapsed_seconds: i64,
    pub cpu_percent: f64,
    pub rss_kb: i64,
    pub status: String,
    pub stale: bool,
    pub listening_ports: Vec<i32>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SystemLoadSnapshot {
    pub scanned_at_ms: i64,
    pub scope: Option<String>,
    pub price_catalog_as_of: Option<String>,
    pub total_agent_sessions: usize,
    pub hidden_orphan_sessions: usize,
    pub detached_helper_count: usize,
    pub estimated_live_cost_usd: Option<f64>,
    pub gpu_note: String,
    pub top_cpu_label: Option<String>,
    pub top_cpu_percent: Option<f64>,
    pub top_memory_label: Option<String>,
    pub top_memory_rss_kb: Option<i64>,
    pub agent_sessions: Vec<AgentSessionRow>,
    pub helper_processes: Vec<HelperProcessRow>,
    pub daemon_processes: Vec<DaemonProcessRow>,
    pub external_burden: Vec<ExternalProcessRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KillResult {
    pub target_label: String,
    pub terminated_pids: Vec<i32>,
    pub closed_ptys: Vec<String>,
    pub deregistered_instances: Vec<String>,
    pub skipped_pids: Vec<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KillSummary {
    pub session_trees_killed: usize,
    pub helper_sets_killed: usize,
    pub terminated_pids: Vec<i32>,
    pub closed_ptys: Vec<String>,
    pub deregistered_instances: Vec<String>,
    pub skipped_targets: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct ProcessInfo {
    pid: i32,
    ppid: i32,
    pgid: i32,
    tty: Option<String>,
    elapsed_seconds: i64,
    started_at_epoch: i64,
    cpu_percent: f64,
    rss_kb: i64,
    command: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeUsageTotals {
    pub model: Option<String>,
    pub input_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_creation_ephemeral_5m_input_tokens: i64,
    pub cache_creation_ephemeral_1h_input_tokens: i64,
    pub cache_read_input_tokens: i64,
    pub output_tokens: i64,
}

impl ClaudeUsageTotals {
    fn total_tokens(&self) -> i64 {
        self.input_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
            + self.output_tokens
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexThreadRecord {
    pub id: String,
    pub cwd: String,
    pub model_provider: Option<String>,
    pub model: Option<String>,
    pub tokens_used: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PriceCatalogEntry {
    pub provider: String,
    pub model: String,
    pub input_per_million_usd: Option<f64>,
    pub cached_input_per_million_usd: Option<f64>,
    pub output_per_million_usd: Option<f64>,
    pub cache_write_5m_per_million_usd: Option<f64>,
    pub cache_write_1h_per_million_usd: Option<f64>,
    pub as_of: String,
}

#[derive(Debug, Deserialize)]
struct PriceCatalogFile {
    as_of: String,
    entries: Vec<PriceCatalogSeed>,
}

#[derive(Debug, Deserialize)]
struct PriceCatalogSeed {
    provider: String,
    model: String,
    input_per_million_usd: Option<f64>,
    cached_input_per_million_usd: Option<f64>,
    output_per_million_usd: Option<f64>,
    cache_write_5m_per_million_usd: Option<f64>,
    cache_write_1h_per_million_usd: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ClaudeSessionMeta {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
}

#[derive(Debug)]
struct SessionBuildContext<'a> {
    price_catalog: &'a [PriceCatalogEntry],
    active_task_counts: &'a HashMap<String, usize>,
    by_pid: &'a HashMap<i32, ProcessInfo>,
    groups: &'a HashMap<i32, Vec<ProcessInfo>>,
    codex_threads: &'a [CodexThreadRecord],
}

#[derive(Debug, Clone)]
struct UsageOutcome {
    model: Option<String>,
    tokens_exact: Option<i64>,
    cost_estimated_usd: Option<f64>,
    usage_confidence: UsageConfidence,
    cost_confidence: UsageConfidence,
    attribution: Option<UsageAttribution>,
}

#[derive(Debug)]
struct ProcessTopline {
    label: String,
    cpu_percent: f64,
    rss_kb: i64,
}

#[derive(Debug)]
struct AttachedHelperBundle {
    rows: Vec<HelperProcessRow>,
    helper_count: usize,
    pids: Vec<i32>,
}

#[tauri::command]
pub fn ui_scan_system_load(
    binder: State<'_, Binder>,
    manager: State<'_, PtyManager>,
    scope: Option<String>,
) -> Result<SystemLoadSnapshot, AppError> {
    scan_system_load_internal(&binder, &manager, scope.as_deref()).map_err(AppError::Operation)
}

#[tauri::command]
pub async fn ui_kill_session_tree(
    binder: State<'_, Binder>,
    target: KillTarget,
) -> Result<KillResult, AppError> {
    kill_target_internal(&binder, target).await
}

#[tauri::command]
pub async fn ui_kill_all_agent_sessions(
    binder: State<'_, Binder>,
    manager: State<'_, PtyManager>,
    scope: Option<String>,
) -> Result<KillSummary, AppError> {
    let snapshot = scan_system_load_internal(&binder, &manager, scope.as_deref())
        .map_err(AppError::Operation)?;

    let mut summary = KillSummary {
        session_trees_killed: 0,
        helper_sets_killed: 0,
        terminated_pids: Vec::new(),
        closed_ptys: Vec::new(),
        deregistered_instances: Vec::new(),
        skipped_targets: 0,
    };

    for row in &snapshot.agent_sessions {
        if !row.killable {
            summary.skipped_targets += 1;
            continue;
        }
        let result = kill_target_internal(&binder, row.kill_target.clone()).await?;
        if !result.terminated_pids.is_empty()
            || !result.closed_ptys.is_empty()
            || !result.deregistered_instances.is_empty()
        {
            summary.session_trees_killed += 1;
        } else {
            summary.skipped_targets += 1;
        }
        summary.terminated_pids.extend(result.terminated_pids);
        summary.closed_ptys.extend(result.closed_ptys);
        summary
            .deregistered_instances
            .extend(result.deregistered_instances);
    }

    if scope.is_none() {
        for row in &snapshot.helper_processes {
            let Some(target) = row.kill_target.clone() else {
                continue;
            };
            if !row.killable {
                summary.skipped_targets += 1;
                continue;
            }
            let result = kill_target_internal(&binder, target).await?;
            if !result.terminated_pids.is_empty() {
                summary.helper_sets_killed += 1;
            } else {
                summary.skipped_targets += 1;
            }
            summary.terminated_pids.extend(result.terminated_pids);
            summary.closed_ptys.extend(result.closed_ptys);
            summary
                .deregistered_instances
                .extend(result.deregistered_instances);
        }
    }

    summary.terminated_pids.sort_unstable();
    summary.terminated_pids.dedup();
    summary.closed_ptys.sort();
    summary.closed_ptys.dedup();
    summary.deregistered_instances.sort();
    summary.deregistered_instances.dedup();
    Ok(summary)
}

pub(crate) async fn kill_target_internal(
    binder: &Binder,
    target: KillTarget,
) -> Result<KillResult, AppError> {
    match target {
        KillTarget::BoundInstance { instance_id } => {
            let trimmed = instance_id.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation("instance_id is required".into()));
            }

            let info = {
                let conn = writes::open_rw().map_err(AppError::Operation)?;
                writes::load_instance_info(&conn, trimmed)
                    .map_err(AppError::Operation)?
                    .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?
            };

            let mut result = KillResult {
                target_label: info.label.clone().unwrap_or_else(|| trimmed.to_owned()),
                terminated_pids: Vec::new(),
                closed_ptys: Vec::new(),
                deregistered_instances: Vec::new(),
                skipped_pids: Vec::new(),
                note: None,
            };

            if let Some(pty_id) = binder.resolved_pty_for(trimmed) {
                if daemon::close_pty(&pty_id, true).await.is_ok() {
                    result.closed_ptys.push(pty_id);
                }
            }

            if info.pid > 0 {
                let processes = load_processes().map_err(AppError::Operation)?;
                let by_pid = index_processes_by_pid(&processes);
                if let Some(process) = by_pid.get(&(info.pid as i32)) {
                    let group = processes
                        .iter()
                        .filter(|member| member.pgid == process.pgid)
                        .cloned()
                        .collect::<Vec<_>>();
                    if let Some(reason) = protected_reason_for_group(&group, process.pgid) {
                        result.note = Some(reason);
                    } else {
                        let killed = kill_process_group(process.pgid).await?;
                        result.terminated_pids.extend(killed);
                    }
                }
            }

            let conn = writes::open_rw().map_err(AppError::Operation)?;
            match writes::deregister_instance(&conn, trimmed) {
                Ok(()) => {}
                Err(err) if err.contains("not found") => {}
                Err(err) => return Err(AppError::Operation(err)),
            }
            binder.unbind(trimmed);
            result.deregistered_instances.push(trimmed.to_owned());
            result.terminated_pids.sort_unstable();
            result.terminated_pids.dedup();
            Ok(result)
        }
        KillTarget::OrphanPtySession { pty_id } => {
            let trimmed = pty_id.trim();
            if trimmed.is_empty() {
                return Err(AppError::Validation("pty_id is required".into()));
            }
            daemon::close_pty(trimmed, true)
                .await
                .map_err(AppError::Operation)?;
            Ok(KillResult {
                target_label: format!("PTY {trimmed}"),
                terminated_pids: Vec::new(),
                closed_ptys: vec![trimmed.to_owned()],
                deregistered_instances: Vec::new(),
                skipped_pids: Vec::new(),
                note: None,
            })
        }
        KillTarget::TerminalProcessGroup { pgid, root_pid } => {
            if let Some(reason) =
                protected_reason_for_group(&load_processes().map_err(AppError::Operation)?, pgid)
            {
                return Ok(KillResult {
                    target_label: format!("process group {pgid}"),
                    terminated_pids: Vec::new(),
                    closed_ptys: Vec::new(),
                    deregistered_instances: Vec::new(),
                    skipped_pids: root_pid.into_iter().collect(),
                    note: Some(reason),
                });
            }

            let killed = kill_process_group(pgid).await?;
            Ok(KillResult {
                target_label: format!("process group {pgid}"),
                terminated_pids: killed,
                closed_ptys: Vec::new(),
                deregistered_instances: Vec::new(),
                skipped_pids: Vec::new(),
                note: None,
            })
        }
        KillTarget::DetachedMcpProcessSet { pids, label } => {
            let processes = load_processes().map_err(AppError::Operation)?;
            let by_pid = index_processes_by_pid(&processes);
            let mut valid = Vec::new();
            let mut skipped = Vec::new();
            let mut notes = Vec::new();
            for pid in pids {
                if let Some(process) = by_pid.get(&pid) {
                    if let Some(reason) = protected_reason_for_command(&process.command) {
                        skipped.push(pid);
                        notes.push(reason);
                    } else {
                        valid.push(pid);
                    }
                }
            }
            let terminated = kill_pid_set(valid).await?;
            Ok(KillResult {
                target_label: label,
                terminated_pids: terminated,
                closed_ptys: Vec::new(),
                deregistered_instances: Vec::new(),
                skipped_pids: skipped,
                note: if notes.is_empty() {
                    None
                } else {
                    Some(notes.join("; "))
                },
            })
        }
    }
}

fn scan_system_load_internal(
    binder: &Binder,
    manager: &PtyManager,
    scope_filter: Option<&str>,
) -> Result<SystemLoadSnapshot, String> {
    let now_secs = now_epoch_seconds();
    let now_ms = now_epoch_millis();
    let processes = load_processes()?;
    let by_pid = index_processes_by_pid(&processes);
    let groups = group_processes(&processes);
    let db_holders = load_swarm_db_holders()?;
    let port_5444_listeners = load_tcp_listener_pids(5444);
    let daemon_processes = if scope_filter.is_none() {
        build_daemon_process_rows(
            &processes,
            &by_pid,
            process::id() as i32,
            &port_5444_listeners,
        )
    } else {
        Vec::new()
    };
    let pty_sessions = manager.sessions_snapshot().map_err(|err| err.to_string())?;
    let ptys_by_id = pty_sessions
        .iter()
        .cloned()
        .map(|pty| (pty.id.clone(), pty))
        .collect::<HashMap<_, _>>();
    let binding = binder.snapshot();
    let resolved_ptys = binding.resolved.iter().cloned().collect::<HashMap<_, _>>();
    let resolved_pty_ids = binding
        .resolved
        .iter()
        .map(|(_, pty_id)| pty_id.clone())
        .collect::<HashSet<_>>();

    let conn = writes::open_rw()?;
    let instances = load_instances_for_scan(&conn, None)?;
    let active_task_counts = load_active_task_counts(&conn)?;
    drop(conn);

    let (price_as_of, price_catalog) = load_price_catalog()?;
    let codex_threads = load_codex_threads().unwrap_or_default();
    let ctx = SessionBuildContext {
        price_catalog: &price_catalog,
        active_task_counts: &active_task_counts,
        by_pid: &by_pid,
        groups: &groups,
        codex_threads: &codex_threads,
    };

    let mut agent_sessions = Vec::new();
    let mut helper_processes = Vec::new();
    let mut consumed_pgids = HashSet::new();
    let mut consumed_pids = HashSet::new();

    for instance in &instances {
        let pty_id = resolved_ptys.get(&instance.id).cloned();
        let pty = pty_id.as_ref().and_then(|id| ptys_by_id.get(id)).cloned();
        let live_process = if instance.pid > 0 {
            ctx.by_pid.get(&(instance.pid as i32)).cloned()
        } else {
            None
        };
        if live_process.is_none() && pty.is_none() {
            continue;
        }

        let session_key = format!("instance:{}", instance.id);
        let attached = attached_helpers_for_group(
            live_process.as_ref().map(|process| process.pgid),
            &ctx.groups,
            &session_key,
            Some(instance.scope.clone()),
        );
        if let Some(process) = &live_process {
            consumed_pgids.insert(process.pgid);
            for member in ctx.groups.get(&process.pgid).into_iter().flatten() {
                consumed_pids.insert(member.pid);
            }
        }
        consumed_pids.extend(attached.pids.iter().copied());
        helper_processes.extend(attached.rows);

        let row =
            build_bound_instance_row(instance, pty, live_process, attached.helper_count, &ctx);
        agent_sessions.push(row);
    }

    for group in groups.values() {
        let Some(root) = choose_group_root(group) else {
            continue;
        };
        if consumed_pgids.contains(&root.pgid) {
            continue;
        }
        let Some((provider, harness)) = agent_harness_for_command(&root.command) else {
            continue;
        };

        let session_key = format!("{harness}:pgid:{}", root.pgid);
        let attached = attached_helpers_for_group(
            Some(root.pgid),
            &groups,
            &session_key,
            derived_scope_from_cwd(None),
        );
        consumed_pgids.insert(root.pgid);
        consumed_pids.extend(group.iter().map(|process| process.pid));
        consumed_pids.extend(attached.pids.iter().copied());
        helper_processes.extend(attached.rows);

        let row = build_terminal_agent_row(
            provider,
            harness,
            &root,
            group,
            attached.helper_count,
            now_secs,
            &ctx,
        );
        agent_sessions.push(row);
    }

    for pty in &pty_sessions {
        if resolved_pty_ids.contains(&pty.id) {
            continue;
        }
        if !pty_looks_agentic(pty) {
            continue;
        }
        let scope = derived_scope_from_cwd(Some(&pty.cwd));
        if let Some(filter) = scope_filter {
            if scope.as_deref() != Some(filter) {
                continue;
            }
        }
        agent_sessions.push(build_orphan_pty_row(pty, scope));
    }

    helper_processes.extend(detached_helper_rows(
        &groups,
        &consumed_pgids,
        &consumed_pids,
        &db_holders,
    ));
    helper_processes.sort_by(|left, right| right.started_at.cmp(&left.started_at));

    let mut filtered_agent_sessions = agent_sessions
        .into_iter()
        .filter(|row| scope_matches(row.scope.as_deref(), scope_filter))
        .collect::<Vec<_>>();
    filtered_agent_sessions.sort_by(|left, right| {
        right
            .started_at
            .unwrap_or_default()
            .cmp(&left.started_at.unwrap_or_default())
    });

    if let Some(filter) = scope_filter {
        helper_processes.retain(|row| scope_matches(row.scope.as_deref(), Some(filter)));
    }

    let external_burden = if scope_filter.is_none() {
        build_external_burden(&processes, &consumed_pids)
    } else {
        Vec::new()
    };

    let mut toplines = Vec::new();
    toplines.extend(filtered_agent_sessions.iter().map(|row| ProcessTopline {
        label: row.session_label.clone(),
        cpu_percent: row.cpu_percent,
        rss_kb: row.rss_kb,
    }));
    toplines.extend(helper_processes.iter().map(|row| ProcessTopline {
        label: row.label.clone(),
        cpu_percent: row.cpu_percent,
        rss_kb: row.rss_kb,
    }));
    toplines.extend(daemon_processes.iter().map(|row| ProcessTopline {
        label: row.label.clone(),
        cpu_percent: row.cpu_percent,
        rss_kb: row.rss_kb,
    }));
    toplines.extend(external_burden.iter().map(|row| ProcessTopline {
        label: row.label.clone(),
        cpu_percent: row.cpu_percent,
        rss_kb: row.rss_kb,
    }));

    let top_cpu = toplines.iter().max_by(|left, right| {
        left.cpu_percent
            .partial_cmp(&right.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top_memory = toplines.iter().max_by_key(|item| item.rss_kb);

    let estimated_live_cost = sum_optional(
        filtered_agent_sessions
            .iter()
            .map(|row| row.cost_estimated_usd)
            .collect::<Vec<_>>(),
    );

    let hidden_orphan_sessions = filtered_agent_sessions
        .iter()
        .filter(|row| row.session_kind != "bound_swarm_agent")
        .count();
    let detached_helper_count = helper_processes
        .iter()
        .filter(|row| row.parent_session_key.is_none())
        .count();

    Ok(SystemLoadSnapshot {
        scanned_at_ms: now_ms,
        scope: scope_filter.map(str::to_owned),
        price_catalog_as_of: Some(price_as_of),
        total_agent_sessions: filtered_agent_sessions.len(),
        hidden_orphan_sessions,
        detached_helper_count,
        estimated_live_cost_usd: estimated_live_cost,
        gpu_note: "N/A".into(),
        top_cpu_label: top_cpu.map(|item| item.label.clone()),
        top_cpu_percent: top_cpu.map(|item| item.cpu_percent),
        top_memory_label: top_memory.map(|item| item.label.clone()),
        top_memory_rss_kb: top_memory.map(|item| item.rss_kb),
        agent_sessions: filtered_agent_sessions,
        helper_processes,
        daemon_processes,
        external_burden,
    })
}

fn build_bound_instance_row(
    instance: &Instance,
    pty: Option<PtySession>,
    live_process: Option<ProcessInfo>,
    helper_count: usize,
    ctx: &SessionBuildContext<'_>,
) -> AgentSessionRow {
    let label = session_label_for_instance(instance);
    let group_members = live_process
        .as_ref()
        .and_then(|process| ctx.groups.get(&process.pgid))
        .cloned()
        .unwrap_or_default();
    let cpu_percent = if group_members.is_empty() {
        0.0
    } else {
        group_members.iter().map(|member| member.cpu_percent).sum()
    };
    let rss_kb = if group_members.is_empty() {
        0
    } else {
        group_members.iter().map(|member| member.rss_kb).sum()
    };
    let child_pids = if group_members.is_empty() {
        live_process
            .as_ref()
            .map(|process| vec![process.pid])
            .unwrap_or_default()
    } else {
        group_members
            .iter()
            .map(|member| member.pid)
            .collect::<Vec<_>>()
    };

    let tokens = parse_label_tokens(instance.label.as_deref());
    let provider = tokens.provider.clone().or_else(|| {
        live_process.as_ref().and_then(|process| {
            agent_harness_for_command(&process.command).map(|(provider, _)| provider.to_owned())
        })
    });
    let harness = live_process.as_ref().and_then(|process| {
        agent_harness_for_command(&process.command).map(|(_, harness)| harness.to_owned())
    });

    let usage = if harness.as_deref() == Some("claude") {
        load_claude_usage_for_pid(
            live_process
                .as_ref()
                .map(|process| process.pid)
                .unwrap_or(instance.pid as i32),
            ctx.price_catalog,
        )
    } else if harness.as_deref() == Some("codex") {
        let cwd = pty
            .as_ref()
            .map(|session| session.cwd.as_str())
            .or(Some(instance.directory.as_str()));
        load_codex_usage(cwd, live_process.as_ref(), ctx.codex_threads)
    } else {
        UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::na(),
            cost_confidence: UsageConfidence::na(),
            attribution: None,
        }
    };

    let activity = if ctx
        .active_task_counts
        .get(&instance.id)
        .copied()
        .unwrap_or(0)
        > 0
    {
        "task"
    } else if cpu_percent >= 1.0 {
        "running"
    } else {
        "idle"
    };

    let kill_protection_reason = live_process.as_ref().and_then(|process| {
        protected_reason_for_group(
            &ctx.groups
                .get(&process.pgid)
                .cloned()
                .unwrap_or_else(|| vec![process.clone()]),
            process.pgid,
        )
    });

    AgentSessionRow {
        session_key: format!("instance:{}", instance.id),
        session_kind: "bound_swarm_agent".into(),
        session_label: label,
        root_pid: live_process.as_ref().map(|process| process.pid),
        process_group_id: live_process.as_ref().map(|process| process.pgid),
        child_pids,
        tty: live_process
            .as_ref()
            .and_then(|process| process.tty.clone())
            .or_else(|| {
                pty.as_ref()
                    .and_then(|session| tty_from_command(&session.command))
            }),
        pty_id: pty.as_ref().map(|session| session.id.clone()),
        instance_id: Some(instance.id.clone()),
        scope: Some(instance.scope.clone()),
        cwd: pty
            .as_ref()
            .map(|session| session.cwd.clone())
            .or(Some(instance.directory.clone())),
        provider,
        harness,
        model: usage.model,
        started_at: live_process
            .as_ref()
            .map(|process| process.started_at_epoch.saturating_mul(1000))
            .or_else(|| pty.as_ref().map(|session| session.started_at)),
        elapsed_seconds: live_process
            .as_ref()
            .map(|process| process.elapsed_seconds)
            .or_else(|| pty.as_ref().map(pty_elapsed_seconds)),
        cpu_percent,
        rss_kb,
        status: instance_status_text(instance.status).into(),
        activity: activity.into(),
        helper_count,
        tokens_exact: usage.tokens_exact,
        tokens_estimated: None,
        cost_exact_usd: None,
        cost_estimated_usd: usage.cost_estimated_usd,
        usage_confidence: usage.usage_confidence,
        cost_confidence: usage.cost_confidence,
        usage_attribution: usage.attribution,
        killable: kill_protection_reason.is_none(),
        kill_protection_reason,
        kill_target: KillTarget::BoundInstance {
            instance_id: instance.id.clone(),
        },
    }
}

fn build_terminal_agent_row(
    provider: &str,
    harness: &str,
    root: &ProcessInfo,
    group: &[ProcessInfo],
    helper_count: usize,
    _now_secs: i64,
    ctx: &SessionBuildContext<'_>,
) -> AgentSessionRow {
    let usage = if harness == "claude" {
        load_claude_usage_for_pid(root.pid, ctx.price_catalog)
    } else if harness == "codex" {
        load_codex_usage(None, Some(root), ctx.codex_threads)
    } else {
        UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::na(),
            cost_confidence: UsageConfidence::na(),
            attribution: None,
        }
    };

    let cwd = if harness == "claude" {
        usage
            .attribution
            .as_ref()
            .and_then(|attribution| attribution.link_basis.clone())
    } else {
        None
    };
    let scope = derived_scope_from_cwd(cwd.as_deref());

    AgentSessionRow {
        session_key: format!("{harness}:pgid:{}", root.pgid),
        session_kind: format!("terminal_{harness}"),
        session_label: format!("{} {}", capitalize(harness), root.pid),
        root_pid: Some(root.pid),
        process_group_id: Some(root.pgid),
        child_pids: group.iter().map(|process| process.pid).collect(),
        tty: root.tty.clone(),
        pty_id: None,
        instance_id: None,
        scope,
        cwd,
        provider: Some(provider.to_owned()),
        harness: Some(harness.to_owned()),
        model: usage.model,
        started_at: Some(root.started_at_epoch.saturating_mul(1000)),
        elapsed_seconds: Some(root.elapsed_seconds),
        cpu_percent: group.iter().map(|process| process.cpu_percent).sum(),
        rss_kb: group.iter().map(|process| process.rss_kb).sum(),
        status: "online".into(),
        activity: if root.cpu_percent >= 1.0 {
            "running".into()
        } else {
            "idle".into()
        },
        helper_count,
        tokens_exact: usage.tokens_exact,
        tokens_estimated: None,
        cost_exact_usd: None,
        cost_estimated_usd: usage.cost_estimated_usd,
        usage_confidence: usage.usage_confidence,
        cost_confidence: usage.cost_confidence,
        usage_attribution: usage.attribution,
        killable: protected_reason_for_group(group, root.pgid).is_none(),
        kill_protection_reason: protected_reason_for_group(group, root.pgid),
        kill_target: KillTarget::TerminalProcessGroup {
            pgid: root.pgid,
            root_pid: Some(root.pid),
        },
    }
}

fn build_orphan_pty_row(pty: &PtySession, scope: Option<String>) -> AgentSessionRow {
    let (provider, harness) = harness_from_command(&pty.command)
        .map(|(provider, harness)| (Some(provider.to_owned()), Some(harness.to_owned())))
        .unwrap_or((None, None));

    AgentSessionRow {
        session_key: format!("pty:{}", pty.id),
        session_kind: "orphan_pty_session".into(),
        session_label: format!("PTY {}", pty.id),
        root_pid: None,
        process_group_id: None,
        child_pids: Vec::new(),
        tty: tty_from_command(&pty.command),
        pty_id: Some(pty.id.clone()),
        instance_id: None,
        scope,
        cwd: Some(pty.cwd.clone()),
        provider,
        harness,
        model: None,
        started_at: Some(pty.started_at),
        elapsed_seconds: Some(pty_elapsed_seconds(pty)),
        cpu_percent: 0.0,
        rss_kb: 0,
        status: if pty.launch_token.is_some() {
            "pending".into()
        } else {
            "online".into()
        },
        activity: "idle".into(),
        helper_count: 0,
        tokens_exact: None,
        tokens_estimated: None,
        cost_exact_usd: None,
        cost_estimated_usd: None,
        usage_confidence: UsageConfidence::na(),
        cost_confidence: UsageConfidence::na(),
        usage_attribution: None,
        killable: true,
        kill_protection_reason: None,
        kill_target: KillTarget::OrphanPtySession {
            pty_id: pty.id.clone(),
        },
    }
}

fn attached_helpers_for_group(
    pgid: Option<i32>,
    groups: &HashMap<i32, Vec<ProcessInfo>>,
    session_key: &str,
    scope: Option<String>,
) -> AttachedHelperBundle {
    let Some(group_id) = pgid else {
        return AttachedHelperBundle {
            rows: Vec::new(),
            helper_count: 0,
            pids: Vec::new(),
        };
    };
    let Some(group) = groups.get(&group_id) else {
        return AttachedHelperBundle {
            rows: Vec::new(),
            helper_count: 0,
            pids: Vec::new(),
        };
    };

    let mut helpers = HashMap::<String, Vec<ProcessInfo>>::new();
    for process in group {
        if let Some(kind) = helper_kind_for_command(&process.command) {
            helpers
                .entry(kind.to_owned())
                .or_default()
                .push(process.clone());
        }
    }

    let mut rows = Vec::new();
    let mut pids = Vec::new();
    for (kind, processes) in helpers {
        let Some(root) = choose_group_root(&processes) else {
            continue;
        };
        pids.extend(processes.iter().map(|process| process.pid));
        rows.push(HelperProcessRow {
            helper_key: format!("helper:{session_key}:{kind}"),
            helper_kind: kind.clone(),
            label: helper_label(&kind),
            pid: root.pid,
            pids: processes.iter().map(|process| process.pid).collect(),
            parent_session_key: Some(session_key.to_owned()),
            tty: root.tty.clone(),
            scope: scope.clone(),
            command: root.command.clone(),
            started_at: root.started_at_epoch.saturating_mul(1000),
            elapsed_seconds: root.elapsed_seconds,
            cpu_percent: processes.iter().map(|process| process.cpu_percent).sum(),
            rss_kb: processes.iter().map(|process| process.rss_kb).sum(),
            killable: false,
            kill_protection_reason: Some(
                "Kill the parent session tree to remove attached helpers.".into(),
            ),
            kill_target: None,
        });
    }

    AttachedHelperBundle {
        helper_count: rows.len(),
        rows,
        pids,
    }
}

fn detached_helper_rows(
    groups: &HashMap<i32, Vec<ProcessInfo>>,
    consumed_pgids: &HashSet<i32>,
    consumed_pids: &HashSet<i32>,
    db_holders: &HashSet<i32>,
) -> Vec<HelperProcessRow> {
    let mut rows = Vec::new();
    for (pgid, group) in groups {
        if consumed_pgids.contains(pgid) {
            continue;
        }
        let mut helpers = HashMap::<String, Vec<ProcessInfo>>::new();
        for process in group {
            if consumed_pids.contains(&process.pid) {
                continue;
            }
            if let Some(kind) = helper_kind_for_command(&process.command) {
                if kind == "repo_mcp" || db_holders.contains(&process.pid) {
                    helpers
                        .entry(kind.to_owned())
                        .or_default()
                        .push(process.clone());
                }
            }
        }
        for (kind, processes) in helpers {
            let Some(root) = choose_group_root(&processes) else {
                continue;
            };
            let protection = protected_reason_for_group(&processes, *pgid);
            rows.push(HelperProcessRow {
                helper_key: format!("helper:detached:{pgid}:{kind}"),
                helper_kind: kind.clone(),
                label: helper_label(&kind),
                pid: root.pid,
                pids: processes.iter().map(|process| process.pid).collect(),
                parent_session_key: None,
                tty: root.tty.clone(),
                scope: None,
                command: root.command.clone(),
                started_at: root.started_at_epoch.saturating_mul(1000),
                elapsed_seconds: root.elapsed_seconds,
                cpu_percent: processes.iter().map(|process| process.cpu_percent).sum(),
                rss_kb: processes.iter().map(|process| process.rss_kb).sum(),
                killable: protection.is_none(),
                kill_protection_reason: protection.clone(),
                kill_target: protection
                    .is_none()
                    .then_some(KillTarget::DetachedMcpProcessSet {
                        pids: processes.iter().map(|process| process.pid).collect(),
                        label: helper_label(&kind),
                    }),
            });
        }
    }
    rows.sort_by(|left, right| right.started_at.cmp(&left.started_at));
    rows
}

fn build_daemon_process_rows(
    processes: &[ProcessInfo],
    by_pid: &HashMap<i32, ProcessInfo>,
    current_ui_pid: i32,
    port_5444_listeners: &HashSet<i32>,
) -> Vec<DaemonProcessRow> {
    let mut rows = processes
        .iter()
        .filter_map(|process| {
            let kind = daemon_kind_for_command(&process.command)?;
            let parent_label = by_pid.get(&process.ppid).map(|parent| process_label(&parent.command));
            let attached_to_current_ui =
                process.pid == current_ui_pid || is_descendant_of(process.pid, current_ui_pid, by_pid);
            let stale = kind == "swarm_server"
                && !attached_to_current_ui
                && process.elapsed_seconds >= 30 * 60;
            let listening_ports = if port_5444_listeners.contains(&process.pid) {
                vec![5444]
            } else {
                Vec::new()
            };
            let status = if stale {
                "stale_detached"
            } else if attached_to_current_ui {
                "attached"
            } else if kind == "swarm_server" {
                "detached"
            } else {
                "support"
            };
            Some(DaemonProcessRow {
                daemon_key: format!("daemon:{}:{}", kind, process.pid),
                daemon_kind: kind.to_owned(),
                label: daemon_label(kind),
                pid: process.pid,
                parent_pid: process.ppid,
                parent_label,
                process_group_id: process.pgid,
                command: process.command.clone(),
                started_at: process.started_at_epoch.saturating_mul(1000),
                elapsed_seconds: process.elapsed_seconds,
                cpu_percent: process.cpu_percent,
                rss_kb: process.rss_kb,
                status: status.to_owned(),
                stale,
                listening_ports,
                note: daemon_note(kind, status),
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .stale
            .cmp(&left.stale)
            .then_with(|| right.elapsed_seconds.cmp(&left.elapsed_seconds))
    });
    rows
}

fn is_descendant_of(
    pid: i32,
    ancestor_pid: i32,
    by_pid: &HashMap<i32, ProcessInfo>,
) -> bool {
    let mut current = pid;
    let mut seen = HashSet::new();
    while let Some(process) = by_pid.get(&current) {
        if process.ppid == ancestor_pid {
            return true;
        }
        if process.ppid <= 0 || !seen.insert(process.ppid) {
            return false;
        }
        current = process.ppid;
    }
    false
}

fn build_external_burden(
    processes: &[ProcessInfo],
    consumed_pids: &HashSet<i32>,
) -> Vec<ExternalProcessRow> {
    let mut rows = processes
        .iter()
        .filter(|process| !consumed_pids.contains(&process.pid))
        .filter(|process| helper_kind_for_command(&process.command).is_none())
        .filter(|process| agent_harness_for_command(&process.command).is_none())
        .filter(|process| protected_reason_for_command(&process.command).is_none())
        .filter(|process| {
            process.cpu_percent >= EXTERNAL_CPU_THRESHOLD
                || process.rss_kb >= EXTERNAL_RSS_THRESHOLD_KB
        })
        .map(|process| ExternalProcessRow {
            external_key: format!("external:{}", process.pid),
            label: process_label(&process.command),
            pid: process.pid,
            process_group_id: process.pgid,
            tty: process.tty.clone(),
            command: process.command.clone(),
            started_at: process.started_at_epoch.saturating_mul(1000),
            elapsed_seconds: process.elapsed_seconds,
            cpu_percent: process.cpu_percent,
            rss_kb: process.rss_kb,
            note: "Read-only external load".into(),
        })
        .collect::<Vec<_>>();

    rows.sort_by(|left, right| {
        burden_score(right.cpu_percent, right.rss_kb)
            .partial_cmp(&burden_score(left.cpu_percent, left.rss_kb))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(EXTERNAL_LIMIT);
    rows
}

fn burden_score(cpu_percent: f64, rss_kb: i64) -> f64 {
    cpu_percent * 1000.0 + (rss_kb as f64 / 256.0)
}

fn load_instances_for_scan(
    conn: &Connection,
    scope: Option<&str>,
) -> Result<Vec<Instance>, String> {
    let sql = if scope.is_some() {
        "SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, COALESCE(adopted, 1)
         FROM instances
         WHERE scope = ?
         ORDER BY registered_at ASC, id ASC"
    } else {
        "SELECT id, scope, directory, root, file_root, pid, label, registered_at, heartbeat, COALESCE(adopted, 1)
         FROM instances
         ORDER BY registered_at ASC, id ASC"
    };

    let now = now_epoch_seconds();
    let mut stmt = conn
        .prepare(sql)
        .map_err(|err| format!("failed to prepare instances scan: {err}"))?;
    let mut rows = if let Some(scope_value) = scope {
        stmt.query(params![scope_value])
            .map_err(|err| format!("failed to query instances scan: {err}"))?
    } else {
        stmt.query([])
            .map_err(|err| format!("failed to query instances scan: {err}"))?
    };

    let mut instances = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("failed to read instance scan row: {err}"))?
    {
        let heartbeat: i64 = row
            .get(8)
            .map_err(|err| format!("failed to read heartbeat: {err}"))?;
        instances.push(Instance {
            id: row
                .get(0)
                .map_err(|err| format!("failed to read id: {err}"))?,
            scope: row
                .get(1)
                .map_err(|err| format!("failed to read scope: {err}"))?,
            directory: row
                .get(2)
                .map_err(|err| format!("failed to read directory: {err}"))?,
            root: row
                .get(3)
                .map_err(|err| format!("failed to read root: {err}"))?,
            file_root: row
                .get(4)
                .map_err(|err| format!("failed to read file_root: {err}"))?,
            pid: row
                .get(5)
                .map_err(|err| format!("failed to read pid: {err}"))?,
            label: row
                .get(6)
                .map_err(|err| format!("failed to read label: {err}"))?,
            registered_at: row
                .get(7)
                .map_err(|err| format!("failed to read registered_at: {err}"))?,
            heartbeat,
            status: InstanceStatus::from_heartbeat(now, heartbeat),
            adopted: row
                .get::<_, i64>(9)
                .map_err(|err| format!("failed to read adopted: {err}"))?
                != 0,
        });
    }
    Ok(instances)
}

fn load_active_task_counts(conn: &Connection) -> Result<HashMap<String, usize>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT assignee, COUNT(*)
             FROM tasks
             WHERE assignee IS NOT NULL
               AND status IN ('open', 'claimed', 'in_progress')
             GROUP BY assignee",
        )
        .map_err(|err| format!("failed to prepare active task counts: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|err| format!("failed to query active task counts: {err}"))?;
    let mut counts = HashMap::new();
    for row in rows {
        let (assignee, count) =
            row.map_err(|err| format!("failed to read active task row: {err}"))?;
        counts.insert(assignee, usize::try_from(count).unwrap_or_default());
    }
    Ok(counts)
}

fn load_price_catalog() -> Result<(String, Vec<PriceCatalogEntry>), String> {
    let file = serde_json::from_str::<PriceCatalogFile>(PRICE_CATALOG_JSON)
        .map_err(|err| format!("failed to parse price catalog: {err}"))?;
    let entries = file
        .entries
        .into_iter()
        .map(|entry| PriceCatalogEntry {
            provider: entry.provider,
            model: entry.model,
            input_per_million_usd: entry.input_per_million_usd,
            cached_input_per_million_usd: entry.cached_input_per_million_usd,
            output_per_million_usd: entry.output_per_million_usd,
            cache_write_5m_per_million_usd: entry.cache_write_5m_per_million_usd,
            cache_write_1h_per_million_usd: entry.cache_write_1h_per_million_usd,
            as_of: file.as_of.clone(),
        })
        .collect::<Vec<_>>();
    Ok((file.as_of, entries))
}

fn load_processes() -> Result<Vec<ProcessInfo>, String> {
    let now = now_epoch_seconds();
    let output = Command::new("ps")
        .args([
            "-axww",
            "-o",
            "pid=,ppid=,pgid=,tty=,etime=,pcpu=,rss=,command=",
        ])
        .output()
        .map_err(|err| format!("failed to run ps: {err}"))?;
    if !output.status.success() {
        return Err("ps returned non-zero status".into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut processes = Vec::new();
    for line in stdout.lines() {
        if let Some(process) = parse_process_line(line, now) {
            processes.push(process);
        }
    }
    Ok(processes)
}

fn load_swarm_db_holders() -> Result<HashSet<i32>, String> {
    let path = swarm_db_path()?;
    let output = Command::new("lsof")
        .arg("-nP")
        .arg(path)
        .output()
        .map_err(|err| format!("failed to run lsof: {err}"))?;
    if !output.status.success() {
        return Ok(HashSet::new());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pids = HashSet::new();
    for line in stdout.lines().skip(1) {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if let Some(pid) = columns.get(1).and_then(|value| value.parse::<i32>().ok()) {
            pids.insert(pid);
        }
    }
    Ok(pids)
}

fn load_tcp_listener_pids(port: u16) -> HashSet<i32> {
    let output = Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
        .output();
    let Ok(output) = output else {
        return HashSet::new();
    };
    if !output.status.success() {
        return HashSet::new();
    }
    let needle = format!(":{port} ");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter(|line| line.contains(&needle) || line.ends_with(&format!(":{port}")))
        .filter_map(|line| line.split_whitespace().nth(1)?.parse::<i32>().ok())
        .collect()
}

fn index_processes_by_pid(processes: &[ProcessInfo]) -> HashMap<i32, ProcessInfo> {
    processes
        .iter()
        .cloned()
        .map(|process| (process.pid, process))
        .collect()
}

fn group_processes(processes: &[ProcessInfo]) -> HashMap<i32, Vec<ProcessInfo>> {
    let mut groups = HashMap::<i32, Vec<ProcessInfo>>::new();
    for process in processes {
        groups
            .entry(process.pgid)
            .or_default()
            .push(process.clone());
    }
    groups
}

fn choose_group_root(group: &[ProcessInfo]) -> Option<ProcessInfo> {
    group
        .iter()
        .find(|process| process.pid == process.pgid)
        .cloned()
        .or_else(|| group.iter().min_by_key(|process| process.pid).cloned())
}

fn session_label_for_instance(instance: &Instance) -> String {
    let tokens = parse_label_tokens(instance.label.as_deref());
    if let Some(name) = tokens.name {
        return name;
    }
    if let Some(role) = tokens.role {
        return format!(
            "{} {}",
            capitalize(&role),
            instance.id.chars().take(6).collect::<String>()
        );
    }
    instance.id.chars().take(12).collect()
}

fn process_label(command: &str) -> String {
    let first = command.split_whitespace().next().unwrap_or(command);
    Path::new(first)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(first)
        .to_owned()
}

fn helper_label(kind: &str) -> String {
    match kind {
        "context7_mcp" => "context7-mcp".into(),
        "xcodebuildmcp" => "xcodebuildmcp".into(),
        "repo_mcp" => "repo MCP".into(),
        other => other.to_owned(),
    }
}

fn daemon_kind_for_command(command: &str) -> Option<&'static str> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("swarm-server") {
        return Some("swarm_server");
    }
    if lower.contains("/target/debug/swarm-ui") || lower.contains("/swarm-ui.app/") {
        return Some("swarm_ui");
    }
    if lower.contains("tauri dev") {
        return Some("tauri_dev");
    }
    if lower.contains("/node_modules/.bin/vite") && lower.contains("swarm-ui") {
        return Some("vite");
    }
    None
}

fn daemon_label(kind: &str) -> String {
    match kind {
        "swarm_server" => "swarm-server daemon".into(),
        "swarm_ui" => "swarm-ui app".into(),
        "tauri_dev" => "tauri dev launcher".into(),
        "vite" => "swarm-ui Vite dev server".into(),
        other => other.to_owned(),
    }
}

fn daemon_note(kind: &str, status: &str) -> String {
    match (kind, status) {
        ("swarm_server", "stale_detached") => {
            "Detached swarm-server older than 30m; restart or kill before native launch proof.".into()
        }
        ("swarm_server", "detached") => {
            "Detached swarm-server; verify owner before trusting daemon-backed launch results.".into()
        }
        ("swarm_server", "attached") => "Current swarm-ui-owned daemon.".into(),
        ("swarm_ui", _) => "Current or recent swarm-ui app process.".into(),
        ("tauri_dev", _) => "Development launcher; stop it when smoke proof finishes.".into(),
        ("vite", _) => "Vite preview server for frontend hot reload.".into(),
        _ => "Swarm-related process.".into(),
    }
}

fn parse_label_tokens(label: Option<&str>) -> LabelTokens {
    let mut tokens = LabelTokens::default();
    let Some(label_text) = label else {
        return tokens;
    };
    for token in label_text.split_whitespace() {
        if let Some(value) = token.strip_prefix("name:") {
            if !value.is_empty() {
                tokens.name = Some(value.to_owned());
            }
        } else if let Some(value) = token.strip_prefix("provider:") {
            if !value.is_empty() {
                tokens.provider = Some(normalize_provider_token(value));
            }
        } else if let Some(value) = token.strip_prefix("role:") {
            if !value.is_empty() {
                tokens.role = Some(value.to_owned());
            }
        }
    }
    tokens
}

#[derive(Default)]
struct LabelTokens {
    name: Option<String>,
    provider: Option<String>,
    role: Option<String>,
}

fn normalize_provider_token(value: &str) -> String {
    if value.contains("claude") {
        "anthropic".into()
    } else if value.contains("codex") || value.contains("openai") {
        "openai".into()
    } else if value.contains("hermes") || value.contains("nous") {
        "nous".into()
    } else if value.contains("openclaw") {
        "openclaw".into()
    } else {
        value.to_owned()
    }
}

fn harness_from_command(command: &str) -> Option<(&'static str, &'static str)> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("/.local/bin/claude")
        || lower.contains(" claude --")
        || lower.ends_with(" claude")
    {
        return Some(("anthropic", "claude"));
    }
    if lower.contains("/bin/codex") || lower.contains(" codex ") {
        return Some(("openai", "codex"));
    }
    if lower.contains("hermes") {
        return Some(("nous", "hermes"));
    }
    if lower.contains("openclaw") {
        return Some(("openclaw", "openclaw"));
    }
    if lower.contains("opencode") {
        return Some(("opencode", "opencode"));
    }
    None
}

fn agent_harness_for_command(command: &str) -> Option<(&'static str, &'static str)> {
    harness_from_command(command)
}

fn helper_kind_for_command(command: &str) -> Option<&'static str> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("context7-mcp") {
        return Some("context7_mcp");
    }
    if lower.contains("xcodebuildmcp") {
        return Some("xcodebuildmcp");
    }
    if lower.contains("swarm-mcp-active/src/index.ts") {
        return Some("repo_mcp");
    }
    None
}

fn protected_reason_for_command(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    if lower.contains("swarm-server") {
        return Some("Protected swarm-server process".into());
    }
    if lower.contains("/target/debug/swarm-ui") || lower.contains("/swarm-ui.app/") {
        return Some("Protected swarm-ui process".into());
    }
    if lower.contains("tauri dev") {
        return Some("Protected tauri dev process".into());
    }
    if lower.contains("/node_modules/.bin/vite") {
        return Some("Protected vite dev process".into());
    }
    None
}

fn protected_reason_for_group(group: &[ProcessInfo], _pgid: i32) -> Option<String> {
    for process in group {
        if let Some(reason) = protected_reason_for_command(&process.command) {
            return Some(reason);
        }
    }
    None
}

fn derived_scope_from_cwd(cwd: Option<&str>) -> Option<String> {
    let path = cwd?;
    let root = writes::git_root(Path::new(path));
    Some(root.to_string_lossy().to_string())
}

fn scope_matches(scope: Option<&str>, filter: Option<&str>) -> bool {
    match filter {
        Some(filter_value) => scope == Some(filter_value),
        None => true,
    }
}

fn tty_from_command(_command: &str) -> Option<String> {
    None
}

fn pty_elapsed_seconds(pty: &PtySession) -> i64 {
    let started_at_secs = pty.started_at / 1000;
    now_epoch_seconds().saturating_sub(started_at_secs)
}

fn load_claude_usage_for_pid(pid: i32, price_catalog: &[PriceCatalogEntry]) -> UsageOutcome {
    let Some(meta) = load_claude_session_meta(pid) else {
        return UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::unlinked(),
            cost_confidence: UsageConfidence::unlinked(),
            attribution: None,
        };
    };

    let Some(project_log) = find_claude_project_log(&meta.session_id) else {
        return UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::unlinked(),
            cost_confidence: UsageConfidence::unlinked(),
            attribution: Some(UsageAttribution {
                source_kind: "claude_session".into(),
                source_ref: None,
                session_id: Some(meta.session_id),
                thread_id: None,
                link_basis: Some(meta.cwd),
            }),
        };
    };

    let Some(usage) = aggregate_claude_usage_from_path(&project_log) else {
        return UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::na(),
            cost_confidence: UsageConfidence::na(),
            attribution: Some(UsageAttribution {
                source_kind: "claude_project_log".into(),
                source_ref: Some(project_log.display().to_string()),
                session_id: Some(meta.session_id),
                thread_id: None,
                link_basis: Some(meta.cwd),
            }),
        };
    };

    let entry = usage
        .model
        .as_ref()
        .and_then(|model| find_price_entry(price_catalog, "anthropic", model));
    let estimated_cost = entry.and_then(|price| estimate_usage_cost_usd(&usage, price));

    UsageOutcome {
        model: usage.model.clone(),
        tokens_exact: Some(usage.total_tokens()),
        cost_estimated_usd: estimated_cost,
        usage_confidence: UsageConfidence::Exact,
        cost_confidence: if estimated_cost.is_some() {
            UsageConfidence::Estimated
        } else {
            UsageConfidence::na()
        },
        attribution: Some(UsageAttribution {
            source_kind: "claude_project_log".into(),
            source_ref: Some(project_log.display().to_string()),
            session_id: Some(meta.session_id),
            thread_id: None,
            link_basis: Some(meta.cwd),
        }),
    }
}

fn load_codex_usage(
    cwd_hint: Option<&str>,
    process: Option<&ProcessInfo>,
    threads: &[CodexThreadRecord],
) -> UsageOutcome {
    let Some(process) = process else {
        return UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::unlinked(),
            cost_confidence: UsageConfidence::unlinked(),
            attribution: None,
        };
    };
    let Some(thread) = link_codex_thread(
        cwd_hint,
        process.started_at_epoch,
        now_epoch_seconds(),
        threads,
    ) else {
        return UsageOutcome {
            model: None,
            tokens_exact: None,
            cost_estimated_usd: None,
            usage_confidence: UsageConfidence::unlinked(),
            cost_confidence: UsageConfidence::unlinked(),
            attribution: None,
        };
    };

    UsageOutcome {
        model: thread.model.clone(),
        tokens_exact: Some(thread.tokens_used),
        cost_estimated_usd: None,
        usage_confidence: UsageConfidence::Exact,
        cost_confidence: UsageConfidence::na(),
        attribution: Some(UsageAttribution {
            source_kind: "codex_thread".into(),
            source_ref: Some("~/.codex/state_5.sqlite".into()),
            session_id: None,
            thread_id: Some(thread.id.clone()),
            link_basis: Some("cwd + process start + thread recency".into()),
        }),
    }
}

fn load_claude_session_meta(pid: i32) -> Option<ClaudeSessionMeta> {
    let path = dirs::home_dir()?
        .join(".claude")
        .join("sessions")
        .join(format!("{pid}.json"));
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn find_claude_project_log(session_id: &str) -> Option<PathBuf> {
    let root = dirs::home_dir()?.join(".claude").join("projects");
    find_named_file(&root, &format!("{session_id}.jsonl"))
}

fn find_named_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_named_file(&path, name) {
                return Some(found);
            }
            continue;
        }
        if path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == name)
        {
            return Some(path);
        }
    }
    None
}

fn aggregate_claude_usage_from_path(path: &Path) -> Option<ClaudeUsageTotals> {
    let raw = fs::read_to_string(path).ok()?;
    let lines = raw.lines().collect::<Vec<_>>();
    aggregate_claude_usage_from_jsonl_lines(&lines)
}

fn aggregate_claude_usage_from_jsonl_lines(lines: &[&str]) -> Option<ClaudeUsageTotals> {
    let mut totals = ClaudeUsageTotals::default();
    let mut saw_usage = false;

    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(message) = value.get("message") else {
            continue;
        };
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(usage) = message.get("usage") else {
            continue;
        };
        saw_usage = true;
        if totals.model.is_none() {
            totals.model = message
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        totals.input_tokens += json_i64(usage.get("input_tokens"));
        totals.cache_creation_input_tokens += json_i64(usage.get("cache_creation_input_tokens"));
        totals.cache_read_input_tokens += json_i64(usage.get("cache_read_input_tokens"));
        totals.output_tokens += json_i64(usage.get("output_tokens"));
        let cache_creation = usage.get("cache_creation");
        totals.cache_creation_ephemeral_5m_input_tokens +=
            json_i64(cache_creation.and_then(|value| value.get("ephemeral_5m_input_tokens")));
        totals.cache_creation_ephemeral_1h_input_tokens +=
            json_i64(cache_creation.and_then(|value| value.get("ephemeral_1h_input_tokens")));
    }

    saw_usage.then_some(totals)
}

fn json_i64(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or_default()
}

fn load_codex_threads() -> Result<Vec<CodexThreadRecord>, String> {
    let path = dirs::home_dir()
        .ok_or_else(|| "home directory unavailable".to_owned())?
        .join(".codex")
        .join("state_5.sqlite");
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("failed to open Codex state DB: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, cwd, model_provider, model, tokens_used, created_at, updated_at, title
             FROM threads
             WHERE archived = 0
             ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("failed to prepare Codex thread query: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(CodexThreadRecord {
                id: row.get(0)?,
                cwd: row.get(1)?,
                model_provider: row.get(2)?,
                model: row.get(3)?,
                tokens_used: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                title: row.get(7)?,
            })
        })
        .map_err(|err| format!("failed to query Codex threads: {err}"))?;

    let mut threads = Vec::new();
    for row in rows {
        threads.push(row.map_err(|err| format!("failed to read Codex thread row: {err}"))?);
    }
    Ok(threads)
}

fn link_codex_thread<'a>(
    cwd_hint: Option<&str>,
    process_started_at_epoch: i64,
    now_epoch: i64,
    threads: &'a [CodexThreadRecord],
) -> Option<&'a CodexThreadRecord> {
    let cwd = cwd_hint?;
    let exact_recent = threads
        .iter()
        .filter(|thread| thread.cwd == cwd)
        .filter(|thread| {
            thread.updated_at >= process_started_at_epoch.saturating_sub(AGENT_SCOPE_WINDOW_SECS)
        })
        .filter(|thread| thread.created_at <= now_epoch.saturating_add(60))
        .collect::<Vec<_>>();
    match exact_recent.len() {
        1 => return exact_recent.into_iter().next(),
        n if n > 1 => return None,
        _ => {}
    }

    let very_recent = threads
        .iter()
        .filter(|thread| thread.cwd == cwd)
        .filter(|thread| thread.updated_at >= now_epoch.saturating_sub(AGENT_SCOPE_WINDOW_SECS))
        .collect::<Vec<_>>();
    match very_recent.len() {
        1 => very_recent.into_iter().next(),
        _ => None,
    }
}

fn find_price_entry<'a>(
    entries: &'a [PriceCatalogEntry],
    provider: &str,
    model: &str,
) -> Option<&'a PriceCatalogEntry> {
    entries.iter().find(|entry| {
        entry.provider.eq_ignore_ascii_case(provider) && entry.model.eq_ignore_ascii_case(model)
    })
}

fn estimate_usage_cost_usd(usage: &ClaudeUsageTotals, price: &PriceCatalogEntry) -> Option<f64> {
    let mut total = 0.0;

    if usage.input_tokens > 0 {
        total += bucket_cost(usage.input_tokens, price.input_per_million_usd?)?;
    }
    if usage.output_tokens > 0 {
        total += bucket_cost(usage.output_tokens, price.output_per_million_usd?)?;
    }
    if usage.cache_read_input_tokens > 0 {
        total += bucket_cost(
            usage.cache_read_input_tokens,
            price.cached_input_per_million_usd?,
        )?;
    }
    if usage.cache_creation_input_tokens > 0 {
        let known = usage.cache_creation_ephemeral_5m_input_tokens
            + usage.cache_creation_ephemeral_1h_input_tokens;
        if known != usage.cache_creation_input_tokens {
            return None;
        }
        if usage.cache_creation_ephemeral_5m_input_tokens > 0 {
            total += bucket_cost(
                usage.cache_creation_ephemeral_5m_input_tokens,
                price.cache_write_5m_per_million_usd?,
            )?;
        }
        if usage.cache_creation_ephemeral_1h_input_tokens > 0 {
            total += bucket_cost(
                usage.cache_creation_ephemeral_1h_input_tokens,
                price.cache_write_1h_per_million_usd?,
            )?;
        }
    }

    Some(total)
}

fn bucket_cost(tokens: i64, rate: f64) -> Option<f64> {
    Some(tokens as f64 / 1_000_000.0 * rate)
}

fn sum_optional(values: Vec<Option<f64>>) -> Option<f64> {
    let mut total = 0.0;
    let mut saw = false;
    for value in values.into_iter().flatten() {
        total += value;
        saw = true;
    }
    saw.then_some(total)
}

async fn kill_process_group(pgid: i32) -> Result<Vec<i32>, AppError> {
    let processes = load_processes().map_err(AppError::Operation)?;
    let members = processes
        .iter()
        .filter(|process| process.pgid == pgid)
        .map(|process| process.pid)
        .collect::<Vec<_>>();
    if members.is_empty() {
        return Ok(Vec::new());
    }

    signal_group("TERM", pgid)?;
    tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)).await;

    let mut terminated = Vec::new();
    let mut survivors = Vec::new();
    for pid in members {
        if pid_is_alive(pid) {
            survivors.push(pid);
        } else {
            terminated.push(pid);
        }
    }

    if !survivors.is_empty() {
        signal_group("KILL", pgid)?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        for pid in survivors {
            if !pid_is_alive(pid) {
                terminated.push(pid);
            }
        }
    }

    terminated.sort_unstable();
    terminated.dedup();
    Ok(terminated)
}

async fn kill_pid_set(pids: Vec<i32>) -> Result<Vec<i32>, AppError> {
    if pids.is_empty() {
        return Ok(Vec::new());
    }
    signal_pid_set("TERM", &pids)?;
    tokio::time::sleep(Duration::from_millis(KILL_GRACE_MS)).await;

    let mut terminated = Vec::new();
    let mut survivors = Vec::new();
    for pid in pids {
        if pid_is_alive(pid) {
            survivors.push(pid);
        } else {
            terminated.push(pid);
        }
    }

    if !survivors.is_empty() {
        signal_pid_set("KILL", &survivors)?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        for pid in survivors {
            if !pid_is_alive(pid) {
                terminated.push(pid);
            }
        }
    }

    terminated.sort_unstable();
    terminated.dedup();
    Ok(terminated)
}

fn signal_group(signal: &str, pgid: i32) -> Result<(), AppError> {
    Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(format!("-{pgid}"))
        .status()
        .map_err(|err| {
            AppError::Operation(format!("failed to signal process group {pgid}: {err}"))
        })?;
    Ok(())
}

fn signal_pid_set(signal: &str, pids: &[i32]) -> Result<(), AppError> {
    if pids.is_empty() {
        return Ok(());
    }
    let mut command = Command::new("kill");
    command.arg(format!("-{signal}"));
    for pid in pids {
        command.arg(pid.to_string());
    }
    command
        .status()
        .map_err(|err| AppError::Operation(format!("failed to signal pid set: {err}")))?;
    Ok(())
}

fn pid_is_alive(pid: i32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn now_epoch_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn now_epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn parse_elapsed_seconds(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (days, rest) = if let Some((day, remainder)) = trimmed.split_once('-') {
        (day.parse::<i64>().ok()?, remainder)
    } else {
        (0, trimmed)
    };
    let rest = rest.split('.').next().unwrap_or(rest);
    let parts = rest
        .split(':')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    let seconds = match parts.as_slice() {
        [seconds] => seconds.parse::<i64>().ok()?,
        [minutes, seconds] => minutes.parse::<i64>().ok()? * 60 + seconds.parse::<i64>().ok()?,
        [hours, minutes, seconds] => {
            hours.parse::<i64>().ok()? * 3600
                + minutes.parse::<i64>().ok()? * 60
                + seconds.parse::<i64>().ok()?
        }
        _ => return None,
    };

    Some(days * 86_400 + seconds)
}

fn parse_process_line(line: &str, now_epoch: i64) -> Option<ProcessInfo> {
    let mut index = 0usize;
    let pid = next_field(line, &mut index)?.parse::<i32>().ok()?;
    let ppid = next_field(line, &mut index)?.parse::<i32>().ok()?;
    let pgid = next_field(line, &mut index)?.parse::<i32>().ok()?;
    let tty_raw = next_field(line, &mut index)?;
    let elapsed_seconds = parse_elapsed_seconds(next_field(line, &mut index)?)?;
    let cpu_percent = next_field(line, &mut index)?.parse::<f64>().ok()?;
    let rss_kb = next_field(line, &mut index)?.parse::<i64>().ok()?;
    let command = line.get(index..)?.trim_start().to_owned();
    if command.is_empty() {
        return None;
    }

    Some(ProcessInfo {
        pid,
        ppid,
        pgid,
        tty: normalize_tty(tty_raw),
        elapsed_seconds,
        started_at_epoch: now_epoch.saturating_sub(elapsed_seconds),
        cpu_percent,
        rss_kb,
        command,
    })
}

fn next_field<'a>(line: &'a str, index: &mut usize) -> Option<&'a str> {
    let bytes = line.as_bytes();
    while *index < bytes.len() && bytes[*index].is_ascii_whitespace() {
        *index += 1;
    }
    if *index >= bytes.len() {
        return None;
    }
    let start = *index;
    while *index < bytes.len() && !bytes[*index].is_ascii_whitespace() {
        *index += 1;
    }
    line.get(start..*index)
}

fn normalize_tty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == "??" || trimmed == "?" || trimmed == "-" {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn pty_looks_agentic(pty: &PtySession) -> bool {
    pty.launch_token.is_some()
        || pty.bound_instance_id.is_some()
        || harness_from_command(&pty.command).is_some()
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn instance_status_text(status: InstanceStatus) -> &'static str {
    match status {
        InstanceStatus::Online => "online",
        InstanceStatus::Stale => "stale",
        InstanceStatus::Offline => "offline",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::{
        ClaudeUsageTotals, CodexThreadRecord, PriceCatalogEntry, UsageConfidence,
        aggregate_claude_usage_from_jsonl_lines, build_daemon_process_rows,
        daemon_kind_for_command, estimate_usage_cost_usd, link_codex_thread, parse_elapsed_seconds,
        parse_process_line, ProcessInfo,
    };

    #[test]
    fn parse_elapsed_seconds_handles_mac_ps_formats() {
        assert_eq!(parse_elapsed_seconds("00:04.12"), Some(4));
        assert_eq!(parse_elapsed_seconds("03:12"), Some(192));
        assert_eq!(parse_elapsed_seconds("01:02:03"), Some(3723));
        assert_eq!(parse_elapsed_seconds("2-03:04:05"), Some(183_845));
    }

    #[test]
    fn parse_process_line_preserves_full_command_and_start_time() {
        let process = parse_process_line(
            "30591 30390 30591 ttys017 16:19:55 0.2 15240 /Users/mathewfrazier/.local/bin/claude --dangerously-skip-permissions",
            1_776_829_600,
        )
        .expect("process line should parse");

        assert_eq!(process.pid, 30_591);
        assert_eq!(process.ppid, 30_390);
        assert_eq!(process.pgid, 30_591);
        assert_eq!(process.tty.as_deref(), Some("ttys017"));
        assert_eq!(process.elapsed_seconds, 58_795);
        assert_eq!(
            process.command,
            "/Users/mathewfrazier/.local/bin/claude --dangerously-skip-permissions"
        );
        assert_eq!(process.started_at_epoch, 1_776_770_805);
    }

    #[test]
    fn aggregate_claude_usage_sums_usage_and_cache_breakdowns() {
        let usage = aggregate_claude_usage_from_jsonl_lines(&[
            r#"{"message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":6,"cache_creation_input_tokens":15209,"cache_read_input_tokens":15095,"output_tokens":227,"cache_creation":{"ephemeral_1h_input_tokens":15209,"ephemeral_5m_input_tokens":0}}}}"#,
            r#"{"message":{"role":"assistant","model":"claude-opus-4-7","usage":{"input_tokens":1,"cache_creation_input_tokens":1108,"cache_read_input_tokens":32555,"output_tokens":364,"cache_creation":{"ephemeral_1h_input_tokens":1108,"ephemeral_5m_input_tokens":0}}}}"#,
        ])
        .expect("usage should parse");

        assert_eq!(
            usage,
            ClaudeUsageTotals {
                model: Some("claude-opus-4-7".into()),
                input_tokens: 7,
                cache_creation_input_tokens: 16_317,
                cache_creation_ephemeral_5m_input_tokens: 0,
                cache_creation_ephemeral_1h_input_tokens: 16_317,
                cache_read_input_tokens: 47_650,
                output_tokens: 591,
            }
        );
    }

    #[test]
    fn estimate_usage_cost_requires_prices_for_every_used_bucket() {
        let usage = ClaudeUsageTotals {
            model: Some("claude-opus-4-7".into()),
            input_tokens: 5_000,
            cache_creation_input_tokens: 20_000,
            cache_creation_ephemeral_5m_input_tokens: 0,
            cache_creation_ephemeral_1h_input_tokens: 20_000,
            cache_read_input_tokens: 10_000,
            output_tokens: 2_000,
        };

        let incomplete = PriceCatalogEntry {
            provider: "anthropic".into(),
            model: "claude-opus-4-7".into(),
            input_per_million_usd: Some(5.0),
            cached_input_per_million_usd: None,
            output_per_million_usd: Some(25.0),
            cache_write_5m_per_million_usd: None,
            cache_write_1h_per_million_usd: None,
            as_of: "2026-04-22".into(),
        };
        assert_eq!(estimate_usage_cost_usd(&usage, &incomplete), None);

        let complete = PriceCatalogEntry {
            provider: "anthropic".into(),
            model: "claude-opus-4-7".into(),
            input_per_million_usd: Some(5.0),
            cached_input_per_million_usd: Some(0.5),
            output_per_million_usd: Some(25.0),
            cache_write_5m_per_million_usd: Some(6.25),
            cache_write_1h_per_million_usd: Some(10.0),
            as_of: "2026-04-22".into(),
        };
        let cost =
            estimate_usage_cost_usd(&usage, &complete).expect("complete pricing should estimate");
        assert!((cost - 0.28).abs() < 0.000_001);
    }

    #[test]
    fn link_codex_thread_requires_unique_recent_match() {
        let threads = vec![
            CodexThreadRecord {
                id: "thread-1".into(),
                cwd: "/Users/mathewfrazier/Desktop/swarm-mcp-active".into(),
                model_provider: Some("openai".into()),
                model: Some("gpt-5.4".into()),
                tokens_used: 1_000,
                created_at: 1_776_887_000,
                updated_at: 1_776_888_050,
                title: Some("Investigate missing swarm node".into()),
            },
            CodexThreadRecord {
                id: "thread-2".into(),
                cwd: "/Users/mathewfrazier/Desktop/swarm-mcp-active".into(),
                model_provider: Some("openai".into()),
                model: Some("gpt-5.4".into()),
                tokens_used: 2_000,
                created_at: 1_776_700_000,
                updated_at: 1_776_700_100,
                title: Some("Older session".into()),
            },
        ];

        let linked = link_codex_thread(
            Some("/Users/mathewfrazier/Desktop/swarm-mcp-active"),
            1_776_887_900,
            1_776_888_100,
            &threads,
        );
        assert_eq!(linked.map(|thread| thread.id.as_str()), Some("thread-1"));

        let ambiguous = link_codex_thread(
            Some("/Users/mathewfrazier/Desktop/swarm-mcp-active"),
            1_776_699_900,
            1_776_888_100,
            &threads,
        );
        assert!(ambiguous.is_none());
    }

    #[test]
    fn usage_confidence_marks_missing_codex_link_as_unlinked() {
        assert_eq!(UsageConfidence::unlinked(), UsageConfidence::Unlinked);
        assert_eq!(UsageConfidence::na(), UsageConfidence::Na);
    }

    #[test]
    fn daemon_classifier_detects_swarm_ui_support_processes() {
        assert_eq!(
            daemon_kind_for_command(
                "/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-server"
            ),
            Some("swarm_server")
        );
        assert_eq!(
            daemon_kind_for_command(
                "/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui"
            ),
            Some("swarm_ui")
        );
        assert_eq!(
            daemon_kind_for_command("bunx tauri dev --runner cargo"),
            Some("tauri_dev")
        );
        assert_eq!(
            daemon_kind_for_command(
                "node /Users/mathewfrazier/Desktop/swarm-mcp-lab/apps/swarm-ui/node_modules/.bin/vite"
            ),
            Some("vite")
        );
        assert_eq!(daemon_kind_for_command("/usr/sbin/cfprefsd"), None);
    }

    #[test]
    fn daemon_rows_flag_old_detached_swarm_server() {
        let processes = vec![
            ProcessInfo {
                pid: 100,
                ppid: 1,
                pgid: 100,
                tty: None,
                elapsed_seconds: 120,
                started_at_epoch: 1_776_800_000,
                cpu_percent: 1.0,
                rss_kb: 40_000,
                command: "/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-ui"
                    .into(),
            },
            ProcessInfo {
                pid: 101,
                ppid: 100,
                pgid: 100,
                tty: None,
                elapsed_seconds: 90,
                started_at_epoch: 1_776_800_030,
                cpu_percent: 0.2,
                rss_kb: 12_000,
                command:
                    "/Users/mathewfrazier/Desktop/swarm-mcp-lab/target/debug/swarm-server".into(),
            },
            ProcessInfo {
                pid: 200,
                ppid: 1,
                pgid: 200,
                tty: None,
                elapsed_seconds: 5 * 24 * 60 * 60,
                started_at_epoch: 1_776_400_000,
                cpu_percent: 0.1,
                rss_kb: 10_000,
                command: "/tmp/swarm-server-fresh/target/debug/swarm-server".into(),
            },
        ];
        let by_pid = processes
            .iter()
            .cloned()
            .map(|process| (process.pid, process))
            .collect::<HashMap<_, _>>();
        let port_5444_listeners = HashSet::from([200]);

        let rows = build_daemon_process_rows(&processes, &by_pid, 100, &port_5444_listeners);

        let attached = rows
            .iter()
            .find(|row| row.pid == 101)
            .expect("current UI child daemon should be visible");
        assert_eq!(attached.status, "attached");
        assert!(!attached.stale);
        assert!(attached.listening_ports.is_empty());

        let stale = rows
            .iter()
            .find(|row| row.pid == 200)
            .expect("old detached daemon should be visible");
        assert_eq!(stale.status, "stale_detached");
        assert!(stale.stale);
        assert_eq!(stale.listening_ports, vec![5444]);
    }
}
