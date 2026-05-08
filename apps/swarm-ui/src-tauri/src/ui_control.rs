use std::time::Duration;
use std::{fs, path::PathBuf, thread};

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::{
    bind::Binder,
    launch::{self, LaunchConfig},
    model::{GraphPosition, Instance, PtySession},
    pty::PtyManager,
    swarm::get_swarm_state,
    system_load::{self, KillTarget},
    writes::{self, UiCommandRecord},
};

const UI_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(250);
const GRID_COLS: usize = 3;
const GRID_CELL_W: f64 = 420.0;
const GRID_CELL_H: f64 = 360.0;
const GRID_PAD_X: f64 = 60.0;
const GRID_PAD_Y: f64 = 60.0;

#[derive(Debug, Deserialize)]
struct SpawnShellPayload {
    cwd: String,
    harness: Option<String>,
    role: Option<String>,
    label: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SendPromptPayload {
    target: String,
    text: String,
    enter: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct KillInstancePayload {
    instance_id: String,
}

#[derive(Debug, Deserialize)]
struct MoveNodePayload {
    target: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Deserialize)]
struct OrganizeNodesPayload {
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExportLayoutPayload {
    scope: Option<String>,
    out: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScreenshotPayload {
    out: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProofPackPayload {
    out: Option<String>,
    note: Option<String>,
    surface: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowserOpenPayload {
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowserCaptureSnapshotPayload {
    context_id: Option<String>,
    tab_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowserClosePayload {
    context_id: Option<String>,
}

pub fn start_ui_command_worker<R: Runtime + 'static>(app_handle: AppHandle<R>) {
    let worker_id = format!("swarm-ui:{}", Uuid::new_v4().simple());
    thread::spawn(move || worker_loop(app_handle, worker_id));
}

fn worker_loop<R: Runtime>(app_handle: AppHandle<R>, worker_id: String) {
    loop {
        let processed = process_pending_commands(&app_handle, &worker_id);
        if !processed {
            thread::sleep(UI_COMMAND_POLL_INTERVAL);
        }
    }
}

fn process_pending_commands<R: Runtime>(app_handle: &AppHandle<R>, worker_id: &str) -> bool {
    let conn = match writes::open_rw() {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("[ui-control] failed to open swarm.db: {err}");
            thread::sleep(UI_COMMAND_POLL_INTERVAL);
            return false;
        }
    };

    let mut processed_any = false;
    loop {
        let record = match writes::claim_next_ui_command(&conn, worker_id) {
            Ok(Some(record)) => record,
            Ok(None) => return processed_any,
            Err(err) => {
                eprintln!("[ui-control] failed to claim ui command: {err}");
                return processed_any;
            }
        };
        processed_any = true;

        match execute_command(app_handle, &conn, &record) {
            Ok(result) => {
                if let Err(err) = writes::complete_ui_command(&conn, &record, &result) {
                    eprintln!(
                        "[ui-control] failed to mark command {} done: {err}",
                        record.id
                    );
                }
            }
            Err(err) => {
                if let Err(mark_err) = writes::fail_ui_command(&conn, &record, &err) {
                    eprintln!(
                        "[ui-control] failed to mark command {} failed: {mark_err}",
                        record.id
                    );
                }
            }
        }
    }
}

fn execute_command<R: Runtime>(
    app_handle: &AppHandle<R>,
    conn: &Connection,
    record: &UiCommandRecord,
) -> Result<Value, String> {
    match record.kind.as_str() {
        "spawn_shell" => {
            let payload: SpawnShellPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid spawn_shell payload: {err}"))?;
            let pty_manager = app_handle.state::<PtyManager>();
            let binder = app_handle.state::<Binder>();
            let launch_config = app_handle.state::<LaunchConfig>();
            let result = launch::spawn_shell_impl(
                app_handle,
                &pty_manager,
                &binder,
                &launch_config,
                payload.cwd,
                payload.harness,
                payload.role,
                Some(record.scope.clone()),
                payload.label,
                payload.name,
            )
            .map_err(|err| err.to_string())?;
            serde_json::to_value(result).map_err(|err| format!("failed to serialize result: {err}"))
        }
        "send_prompt" => {
            let payload: SendPromptPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid send_prompt payload: {err}"))?;
            let (pty_id, node_id) =
                resolve_prompt_target(app_handle, &record.scope, &payload.target)?;
            let mut data = payload.text.into_bytes();
            if payload.enter.unwrap_or(true) {
                data.push(b'\n');
            }
            app_handle
                .state::<PtyManager>()
                .write_input(&pty_id, &data)
                .map_err(|err| err.to_string())?;
            Ok(json!({
                "pty_id": pty_id,
                "node_id": node_id,
                "bytes": data.len(),
            }))
        }
        "kill_instance" => {
            let payload: KillInstancePayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid kill_instance payload: {err}"))?;
            let instance_id = payload.instance_id.trim();
            if instance_id.is_empty() {
                return Err("instance_id is required".to_owned());
            }
            let binder = app_handle.state::<Binder>();
            let result = tauri::async_runtime::block_on(system_load::kill_target_internal(
                &binder,
                KillTarget::BoundInstance {
                    instance_id: instance_id.to_owned(),
                },
            ))
            .map_err(|err| err.to_string())?;
            serde_json::to_value(result).map_err(|err| format!("failed to serialize result: {err}"))
        }
        "move_node" => {
            let payload: MoveNodePayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid move_node payload: {err}"))?;
            let node_id = resolve_layout_target(app_handle, &record.scope, &payload.target)?;
            writes::set_ui_layout_position(
                conn,
                &record.scope,
                &node_id,
                GraphPosition {
                    x: payload.x,
                    y: payload.y,
                },
            )?;
            Ok(json!({
                "node_id": node_id,
                "x": payload.x,
                "y": payload.y,
            }))
        }
        "organize_nodes" => {
            let payload: OrganizeNodesPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid organize_nodes payload: {err}"))?;
            let kind = payload.kind.unwrap_or_else(|| "grid".to_owned());
            if kind != "grid" {
                return Err(format!("unsupported organize kind: {kind}"));
            }

            let node_ids = current_node_ids_for_scope(app_handle, &record.scope)?;
            let mut layout = writes::load_ui_layout(conn, &record.scope)?;
            layout.nodes.clear();
            for (index, node_id) in node_ids.iter().enumerate() {
                let col = index % GRID_COLS;
                let row = index / GRID_COLS;
                layout.nodes.insert(
                    node_id.clone(),
                    GraphPosition {
                        x: GRID_PAD_X + (col as f64 * GRID_CELL_W),
                        y: GRID_PAD_Y + (row as f64 * GRID_CELL_H),
                    },
                );
            }
            writes::save_ui_layout(conn, &record.scope, &layout)?;
            Ok(json!({
                "kind": kind,
                "node_count": layout.nodes.len(),
            }))
        }
        "ui.export-layout" => {
            let payload: ExportLayoutPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid ui.export-layout payload: {err}"))?;
            let export_scope = payload
                .scope
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&record.scope);
            let layout = writes::load_ui_layout(conn, export_scope)?;
            let path = resolve_artifact_path(payload.out.as_deref(), "swarm-ui-layout", "json")?;
            let exported_at_ms = unix_millis();
            let body = json!({
                "version": 1,
                "exportedAtUnixMs": exported_at_ms,
                "scope": export_scope,
                "layout": layout,
            });
            write_json_artifact(&path, &body)?;
            Ok(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "scope": export_scope,
                "node_count": body
                    .get("layout")
                    .and_then(|value| value.get("nodes"))
                    .and_then(|value| value.as_object())
                    .map(|nodes| nodes.len())
                    .unwrap_or(0),
            }))
        }
        "ui.screenshot" => {
            let payload: ScreenshotPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid ui.screenshot payload: {err}"))?;
            let _requested_path = payload.out.as_deref();
            Ok(json!({
                "ok": false,
                "error": "window screenshot capture unavailable in this runtime",
            }))
        }
        "ui.proof-pack" => {
            let payload: ProofPackPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid ui.proof-pack payload: {err}"))?;
            let generated_at_ms = unix_millis();
            let path =
                resolve_artifact_path(payload.out.as_deref(), "swarm-ui-proof-pack", "json")?;
            let surface = payload
                .surface
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("cli");
            let note = payload
                .note
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let body = json!({
                "version": 1,
                "kind": "swarm-ui-proof-pack",
                "generatedAtUnixMs": generated_at_ms,
                "surface": surface,
                "note": note,
                "scope": record.scope,
                "source": "ui.proof-pack",
                "command": {
                    "id": record.id,
                    "createdBy": record.created_by,
                },
                "evidence": {
                    "screenshot": {
                        "ok": false,
                        "error": "window screenshot capture unavailable in this runtime",
                    },
                    "visual": {
                        "semanticSnapshot": [],
                        "scrollContainers": [],
                        "themeVariables": {},
                        "note": "The CLI command path can write the proof-pack artifact, but DOM evidence requires the Project Task Board button inside swarm-ui.",
                    },
                },
                "reviewSignals": [{
                    "id": "cli-dom-evidence-unavailable",
                    "status": "warn",
                    "title": "CLI proof pack has no DOM snapshot",
                    "detail": "Use the Project Task Board Capture proof pack button for semantic UI bounds, text, theme variables, and scroll containers.",
                }],
                "artifact": {
                    "kind": "swarm-ui-proof-pack-artifact",
                    "writtenAtUnixMs": generated_at_ms,
                    "path": path.to_string_lossy(),
                },
            });
            write_json_artifact(&path, &body)?;
            let byte_count = fs::metadata(&path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            Ok(json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "scope": record.scope,
                "surface": surface,
                "byte_count": byte_count,
            }))
        }
        "browser.open" => {
            let payload: BrowserOpenPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid browser.open payload: {err}"))?;
            let catalog = crate::ui_commands::ui_open_browser_context(
                record.scope.clone(),
                payload.url.filter(|url| !url.trim().is_empty()),
                Some(true),
            )
            .map_err(|err| err.to_string())?;
            serde_json::to_value(catalog)
                .map_err(|err| format!("failed to serialize result: {err}"))
        }
        "browser.import-active-tab" => {
            let catalog = crate::ui_commands::ui_import_front_chrome_tab(record.scope.clone())
                .map_err(|err| err.to_string())?;
            serde_json::to_value(catalog)
                .map_err(|err| format!("failed to serialize result: {err}"))
        }
        "browser.capture-snapshot" => {
            let payload: BrowserCaptureSnapshotPayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid browser.capture-snapshot payload: {err}"))?;
            let context_id = payload
                .context_id
                .filter(|id| !id.trim().is_empty())
                .map_or_else(|| latest_open_browser_context_id(conn, &record.scope), Ok)?;
            let tab_id = payload.tab_id.filter(|id| !id.trim().is_empty());
            let catalog =
                tauri::async_runtime::block_on(crate::ui_commands::ui_capture_browser_snapshot(
                    record.scope.clone(),
                    context_id,
                    tab_id,
                ))
                .map_err(|err| err.to_string())?;
            serde_json::to_value(catalog)
                .map_err(|err| format!("failed to serialize result: {err}"))
        }
        "browser.close" => {
            let payload: BrowserClosePayload = serde_json::from_str(&record.payload)
                .map_err(|err| format!("invalid browser.close payload: {err}"))?;
            let context_id = payload
                .context_id
                .filter(|id| !id.trim().is_empty())
                .map_or_else(|| latest_open_browser_context_id(conn, &record.scope), Ok)?;
            let catalog =
                crate::ui_commands::ui_close_browser_context(record.scope.clone(), context_id)
                    .map_err(|err| err.to_string())?;
            serde_json::to_value(catalog)
                .map_err(|err| format!("failed to serialize result: {err}"))
        }
        other => Err(format!("unsupported ui command kind: {other}")),
    }
}

fn latest_open_browser_context_id(conn: &Connection, scope: &str) -> Result<String, String> {
    writes::list_browser_contexts(conn, scope)?
        .into_iter()
        .find(|context| context.status == "open")
        .map(|context| context.id)
        .ok_or_else(|| "no open browser context in this scope".to_owned())
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn resolve_artifact_path(
    requested: Option<&str>,
    stem: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    if let Some(raw) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(raw));
    }

    let base = dirs::home_dir()
        .ok_or_else(|| "failed to resolve home directory for artifacts".to_owned())?
        .join(".swarm-mcp")
        .join("artifacts");
    Ok(base.join(format!("{stem}-{}.{}", unix_millis(), extension)))
}

fn write_json_artifact(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "failed to create artifact directory {}: {err}",
                parent.display()
            )
        })?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|err| format!("failed to serialize artifact: {err}"))?;
    fs::write(path, raw)
        .map_err(|err| format!("failed to write artifact {}: {err}", path.display()))
}

fn current_node_ids_for_scope<R: Runtime>(
    app_handle: &AppHandle<R>,
    scope: &str,
) -> Result<Vec<String>, String> {
    let snapshot = get_swarm_state().map_err(|err| err.to_string())?;
    let mut instances = snapshot
        .instances
        .into_iter()
        .filter(|instance| instance.scope == scope)
        .collect::<Vec<_>>();
    instances.sort_unstable_by(|left, right| left.id.cmp(&right.id));

    let manager = app_handle.state::<PtyManager>();
    let mut sessions = manager.sessions_snapshot().map_err(|err| err.to_string())?;
    sessions.sort_unstable_by(|left, right| left.id.cmp(&right.id));

    let binding = app_handle.state::<Binder>().snapshot();
    let mut resolved_instance_ids = Vec::new();
    let mut resolved_pty_ids = Vec::new();
    for (instance_id, pty_id) in binding.resolved {
        if instances.iter().any(|instance| instance.id == instance_id) {
            resolved_instance_ids.push(instance_id);
            resolved_pty_ids.push(pty_id);
        }
    }

    let mut node_ids = Vec::new();
    for instance_id in &resolved_instance_ids {
        node_ids.push(format!("bound:{instance_id}"));
    }

    for instance in &instances {
        if resolved_instance_ids.iter().any(|id| id == &instance.id) {
            continue;
        }
        node_ids.push(format!("instance:{}", instance.id));
    }

    for session in &sessions {
        if resolved_pty_ids.iter().any(|id| id == &session.id) {
            continue;
        }
        if let Some(bound_instance_id) = session.bound_instance_id.as_deref() {
            if !instances
                .iter()
                .any(|instance| instance.id == bound_instance_id)
            {
                continue;
            }
        }
        node_ids.push(format!("pty:{}", session.id));
    }

    Ok(node_ids)
}

fn resolve_prompt_target<R: Runtime>(
    app_handle: &AppHandle<R>,
    scope: &str,
    raw: &str,
) -> Result<(String, String), String> {
    let snapshot = get_swarm_state().map_err(|err| err.to_string())?;
    let sessions = app_handle
        .state::<PtyManager>()
        .sessions_snapshot()
        .map_err(|err| err.to_string())?;
    let binder = app_handle.state::<Binder>();
    let target = raw.trim();

    if let Some(instance_id) = target
        .strip_prefix("bound:")
        .or_else(|| target.strip_prefix("instance:"))
    {
        return resolve_instance_prompt(instance_id, &snapshot.instances, scope, &binder);
    }
    if let Some(pty_ref) = target.strip_prefix("pty:") {
        return resolve_pty_prompt(pty_ref, &snapshot.instances, scope, &sessions);
    }

    match find_instance(target, &snapshot.instances, scope)? {
        Some(instance) => {
            resolve_instance_prompt(&instance.id, &snapshot.instances, scope, &binder)
        }
        None => resolve_pty_prompt(target, &snapshot.instances, scope, &sessions),
    }
}

fn resolve_layout_target<R: Runtime>(
    app_handle: &AppHandle<R>,
    scope: &str,
    raw: &str,
) -> Result<String, String> {
    let snapshot = get_swarm_state().map_err(|err| err.to_string())?;
    let sessions = app_handle
        .state::<PtyManager>()
        .sessions_snapshot()
        .map_err(|err| err.to_string())?;
    let binder = app_handle.state::<Binder>();
    let target = raw.trim();

    if let Some(instance_id) = target
        .strip_prefix("bound:")
        .or_else(|| target.strip_prefix("instance:"))
    {
        return resolve_instance_node(instance_id, &snapshot.instances, scope, &binder);
    }
    if let Some(pty_ref) = target.strip_prefix("pty:") {
        return resolve_pty_node(pty_ref, &snapshot.instances, scope, &sessions);
    }

    if let Some(instance) = find_instance(target, &snapshot.instances, scope)? {
        return resolve_instance_node(&instance.id, &snapshot.instances, scope, &binder);
    }
    resolve_pty_node(target, &snapshot.instances, scope, &sessions)
}

fn resolve_instance_prompt(
    instance_ref: &str,
    instances: &[Instance],
    scope: &str,
    binder: &Binder,
) -> Result<(String, String), String> {
    let instance = find_instance(instance_ref, instances, scope)?
        .ok_or_else(|| format!("no instance matches {instance_ref:?} in scope {scope}"))?;
    let Some(pty_id) = binder.resolved_pty_for(&instance.id) else {
        return Err(format!(
            "instance {} has no live PTY bound in swarm-ui",
            instance.id
        ));
    };
    Ok((pty_id, format!("bound:{}", instance.id)))
}

fn resolve_pty_prompt(
    pty_ref: &str,
    instances: &[Instance],
    scope: &str,
    sessions: &[PtySession],
) -> Result<(String, String), String> {
    let session =
        find_pty(pty_ref, sessions)?.ok_or_else(|| format!("no PTY matches {pty_ref:?}"))?;
    let node_id = match session.bound_instance_id.as_deref() {
        Some(instance_id) => {
            let instance = instances
                .iter()
                .find(|instance| instance.id == instance_id)
                .ok_or_else(|| {
                    format!(
                        "PTY {} is bound to instance {} outside scope {}",
                        session.id, instance_id, scope
                    )
                })?;
            if instance.scope != scope {
                return Err(format!(
                    "PTY {} is bound to scope {}, not {}",
                    session.id, instance.scope, scope
                ));
            }
            format!("bound:{instance_id}")
        }
        None => format!("pty:{}", session.id),
    };
    Ok((session.id.clone(), node_id))
}

fn resolve_instance_node(
    instance_ref: &str,
    instances: &[Instance],
    scope: &str,
    binder: &Binder,
) -> Result<String, String> {
    let instance = find_instance(instance_ref, instances, scope)?
        .ok_or_else(|| format!("no instance matches {instance_ref:?} in scope {scope}"))?;
    if binder.resolved_pty_for(&instance.id).is_some() {
        Ok(format!("bound:{}", instance.id))
    } else {
        Ok(format!("instance:{}", instance.id))
    }
}

fn resolve_pty_node(
    pty_ref: &str,
    instances: &[Instance],
    scope: &str,
    sessions: &[PtySession],
) -> Result<String, String> {
    let session =
        find_pty(pty_ref, sessions)?.ok_or_else(|| format!("no PTY matches {pty_ref:?}"))?;
    if let Some(instance_id) = session.bound_instance_id.as_deref() {
        let instance = instances
            .iter()
            .find(|instance| instance.id == instance_id)
            .ok_or_else(|| {
                format!(
                    "PTY {} is bound to instance {} outside scope {}",
                    session.id, instance_id, scope
                )
            })?;
        if instance.scope != scope {
            return Err(format!(
                "PTY {} is bound to scope {}, not {}",
                session.id, instance.scope, scope
            ));
        }
        Ok(format!("bound:{instance_id}"))
    } else {
        Ok(format!("pty:{}", session.id))
    }
}

fn find_instance<'a>(
    raw: &str,
    instances: &'a [Instance],
    scope: &str,
) -> Result<Option<&'a Instance>, String> {
    let scoped = instances
        .iter()
        .filter(|instance| instance.scope == scope)
        .collect::<Vec<_>>();
    if scoped.is_empty() {
        return Ok(None);
    }

    if let Some(instance) = scoped.iter().copied().find(|instance| instance.id == raw) {
        return Ok(Some(instance));
    }

    let prefix = scoped
        .iter()
        .copied()
        .filter(|instance| instance.id.starts_with(raw))
        .collect::<Vec<_>>();
    match prefix.len() {
        1 => return Ok(prefix.into_iter().next()),
        n if n > 1 => {
            return Err(format!(
                "ambiguous instance id prefix {raw:?}: {}",
                prefix
                    .iter()
                    .map(|instance| instance.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        _ => {}
    }

    let label = scoped
        .iter()
        .copied()
        .filter(|instance| {
            instance
                .label
                .as_deref()
                .is_some_and(|label| label.contains(raw))
        })
        .collect::<Vec<_>>();
    match label.len() {
        1 => Ok(label.into_iter().next()),
        n if n > 1 => Err(format!(
            "ambiguous instance label match {raw:?}: {}",
            label
                .iter()
                .map(|instance| instance.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        _ => Ok(None),
    }
}

fn find_pty<'a>(raw: &str, sessions: &'a [PtySession]) -> Result<Option<&'a PtySession>, String> {
    if let Some(session) = sessions.iter().find(|session| session.id == raw) {
        return Ok(Some(session));
    }

    let prefix = sessions
        .iter()
        .filter(|session| session.id.starts_with(raw))
        .collect::<Vec<_>>();
    match prefix.len() {
        1 => return Ok(prefix.into_iter().next()),
        n if n > 1 => {
            return Err(format!(
                "ambiguous PTY id prefix {raw:?}: {}",
                prefix
                    .iter()
                    .map(|session| session.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        _ => {}
    }

    let command = sessions
        .iter()
        .filter(|session| session.command.contains(raw))
        .collect::<Vec<_>>();
    match command.len() {
        1 => Ok(command.into_iter().next()),
        n if n > 1 => Err(format!(
            "ambiguous PTY command match {raw:?}: {}",
            command
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
        _ => Ok(None),
    }
}
