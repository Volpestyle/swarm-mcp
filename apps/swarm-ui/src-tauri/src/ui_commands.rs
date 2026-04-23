// =============================================================================
// ui_commands.rs — Tauri commands for UI-initiated swarm writes
//
// Thin validation layer on top of `writes.rs`, mirroring the validation that
// `src/index.ts` applies before calling the pure helpers in `src/messages.ts`.
// Keeping validation here (not in `writes.rs`) matches the Bun side's split
// between MCP tool handlers and bare DB helpers.
// =============================================================================

use crate::{
    bind::Binder,
    daemon,
    model::{AppError, InstanceStatus, SavedLayout},
    pty::PtyManager,
    system_load::{KillTarget, kill_target_internal},
    writes,
};
use tauri::{AppHandle, Runtime, State};

fn instance_status_from_heartbeat(heartbeat: i64) -> InstanceStatus {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    InstanceStatus::from_heartbeat(now, heartbeat)
}

fn instance_status_label(status: InstanceStatus) -> &'static str {
    match status {
        InstanceStatus::Online => "online",
        InstanceStatus::Stale => "stale",
        InstanceStatus::Offline => "offline",
    }
}

/// Overwrite an instance's `label` column. The frontend composes the new
/// label string (preserving existing tokens like `name:`, `role:`, etc) and
/// sends the whole thing back. Used by the persona picker — when the user
/// changes an agent's emoji, the UI rewrites the `persona:` token in the
/// label and calls this to persist it.
///
/// No scope check: the user explicitly clicked an agent's persona tab, so
/// the choice of agent is theirs. Empty `label` is allowed (clears all
/// tokens). Returns `true` if the row existed and was updated.
#[tauri::command]
pub fn ui_set_instance_label(instance_id: String, label: String) -> Result<bool, AppError> {
    let id = instance_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::update_instance_label(&conn, id, &label).map_err(AppError::Operation)
}

/// Clear all message history between two instances in either direction.
/// Triggered by the Inspector's "Clear messages" button on a selected
/// ConnectionEdge. Both ids must be non-empty; no scope check — the UI
/// shows any pair in the current snapshot so the user decides.
#[tauri::command]
pub fn ui_clear_messages(instance_a: String, instance_b: String) -> Result<usize, AppError> {
    let a = instance_a.trim();
    let b = instance_b.trim();
    if a.is_empty() || b.is_empty() {
        return Err(AppError::Validation(
            "both instance ids are required".into(),
        ));
    }
    if a == b {
        return Err(AppError::Validation(
            "cannot clear messages with the same instance on both sides".into(),
        ));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::clear_messages_between(&conn, a, b).map_err(AppError::Operation)
}

/// Unassign a task. Called from the Inspector's per-task delete button on
/// a selected ConnectionEdge. Resets claimed/in-progress back to open so
/// another agent can pick it up.
#[tauri::command]
pub fn ui_unassign_task(task_id: String) -> Result<bool, AppError> {
    let id = task_id.trim();
    if id.is_empty() {
        return Err(AppError::Validation("task_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::unassign_task(&conn, id).map_err(AppError::Operation)
}

/// Remove one entry from a task's `depends_on` array. Called from the
/// Inspector's per-dependency delete button.
#[tauri::command]
pub fn ui_remove_dependency(
    dependent_task_id: String,
    dependency_task_id: String,
) -> Result<bool, AppError> {
    let dependent = dependent_task_id.trim();
    let dependency = dependency_task_id.trim();
    if dependent.is_empty() || dependency.is_empty() {
        return Err(AppError::Validation("both task ids are required".into()));
    }
    if dependent == dependency {
        return Err(AppError::Validation(
            "a task cannot depend on itself".into(),
        ));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::remove_task_dependency(&conn, dependent, dependency).map_err(AppError::Operation)
}

/// Remove an instance row and everything keyed to it (locks, queued
/// messages, task assignments released). Used when the user clicks the
/// remove button on a disconnected node whose PTY is already gone — e.g.,
/// an orphan row left over from a previous UI session, or a child process
/// the user killed outside the UI.
///
/// No scope check: the UI can see any instance in the snapshot, so the
/// user gets to decide what to clean up. The binder mapping is dropped
/// too so the node doesn't keep rendering as `bound:` against a
/// deleted instance id.
#[tauri::command]
pub fn ui_deregister_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let instance = writes::load_instance_info(&conn, trimmed)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?;

    if binder.resolved_pty_for(trimmed).is_some() {
        return Err(AppError::Validation(format!(
            "instance {trimmed} still has a live PTY in this session"
        )));
    }

    let status = instance_status_from_heartbeat(instance.heartbeat);
    if !matches!(status, InstanceStatus::Stale | InstanceStatus::Offline) {
        return Err(AppError::Validation(format!(
            "instance {trimmed} is {} and cannot be removed yet",
            instance_status_label(status)
        )));
    }

    writes::deregister_instance(&conn, trimmed).map_err(AppError::Operation)?;

    binder.unbind(trimmed);
    Ok(())
}

/// Force-remove an instance row that the user has explicitly asked to nuke
/// from the Home screen, bypassing the gentle policy checks in
/// `ui_deregister_instance`. Needed because the UI surfaces prev-session rows
/// whose heartbeat is still fresh (server-side heartbeating, pre-stale
/// window) or whose binder resolution points at a PTY the daemon has
/// already forgotten about. In both cases the gentle path deadlocks and
/// the × button appears to do nothing.
///
/// Semantics:
///   - If the binder still has a resolution for this id, best-effort close
///     the underlying PTY on the daemon. A failure here (PTY already dead,
///     daemon doesn't know it) is ignored — the user's intent is unambiguous.
///   - Unconditionally drop the binder mapping.
///   - Deregister the row via `writes::deregister_instance`, which cascades
///     task/lock/message cleanup the same way the gentle path does.
///
/// The frontend gates every call to this with a confirm dialog, so the
/// "force" behavior is user-initiated rather than policy-bypassing by
/// default.
#[tauri::command]
pub async fn ui_force_deregister_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::load_instance_info(&conn, trimmed)
        .map_err(AppError::Operation)?
        .ok_or_else(|| AppError::NotFound(format!("instance {trimmed} not found")))?;

    // Best-effort PTY close when the binder has a resolution. Errors from the
    // daemon (unknown PTY, already closed) are swallowed because the user has
    // explicitly asked to tear this row down and any lingering PTY mapping
    // must not block the row deletion.
    if let Some(pty_id) = binder.resolved_pty_for(trimmed) {
        let _ = daemon::close_pty(&pty_id, true).await;
    }

    writes::deregister_instance(&conn, trimmed).map_err(AppError::Operation)?;
    binder.unbind(trimmed);
    Ok(())
}

/// Bulk-delete every instance row whose heartbeat has aged past the "stale"
/// threshold, optionally restricted to one scope. Lets the user one-click
/// clean up a pile of adopting-but-dead nodes instead of trashing each row
/// individually. Live PTYs still bound to an instance are skipped so the
/// user doesn't lose a node they can still interact with.
#[tauri::command]
pub fn ui_deregister_offline_instances(
    binder: State<'_, Binder>,
    scope: Option<String>,
) -> Result<usize, AppError> {
    let scope_filter = scope
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default();
    let stale_cutoff = now.saturating_sub(crate::model::INSTANCE_STALE_AFTER_SECS);

    let mut stmt = conn
        .prepare("SELECT id, scope FROM instances WHERE heartbeat < ?")
        .map_err(|err| AppError::Operation(format!("failed to query offline instances: {err}")))?;
    let rows: Vec<(String, String)> = stmt
        .query_map([stale_cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| {
            AppError::Operation(format!("failed to enumerate offline instances: {err}"))
        })?
        .collect::<Result<_, _>>()
        .map_err(|err| {
            AppError::Operation(format!("failed to read offline instance row: {err}"))
        })?;
    drop(stmt);

    let mut removed = 0usize;
    for (id, row_scope) in rows {
        if let Some(target) = scope_filter {
            if row_scope != target {
                continue;
            }
        }
        if binder.resolved_pty_for(&id).is_some() {
            continue;
        }
        writes::deregister_instance(&conn, &id).map_err(AppError::Operation)?;
        binder.unbind(&id);
        removed += 1;
    }

    Ok(removed)
}

/// Remove stale unadopted placeholder rows that no longer have any live PTY
/// attached. This is the narrow orphan cleanup path used by the Home and
/// Settings diagnostics so recovery cleanup does not touch adopted sessions.
#[tauri::command]
pub fn ui_sweep_unadopted_orphans() -> Result<usize, AppError> {
    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::sweep_unadopted_orphans(&conn).map_err(AppError::Operation)
}

/// Persist the graph layout for one swarm scope under the shared `ui/layout`
/// KV entry. The frontend calls this after local drag/reflow changes so
/// layout becomes durable and can also be driven by the CLI worker.
#[tauri::command]
pub fn ui_set_layout(scope: String, layout: SavedLayout) -> Result<(), AppError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    writes::save_ui_layout(&conn, trimmed, &layout).map_err(AppError::Operation)
}

/// Exit the entire Tauri application process. Used by the UI's quit-confirm
/// dialog so app shutdown does not depend on platform-specific window-close
/// behavior (macOS keeps app lifetime separate from window lifetime).
#[tauri::command]
pub fn ui_exit_app<R: Runtime>(app_handle: AppHandle<R>) {
    app_handle.exit(0);
}

/// Fan-out an operator-authored message to every agent in `scope`. Writes one
/// row per recipient and emits a `message.broadcast` event so ConnectionEdges
/// animate. The sender id is synthesised as `operator:<scope>` to avoid
/// colliding with any real instance id.
///
/// Called from the Conversation panel's message bar. Returns the number of
/// recipient rows inserted — `0` means the scope is empty and nothing was sent.
#[tauri::command]
pub fn ui_broadcast_message(scope: String, content: String) -> Result<usize, AppError> {
    let trimmed_scope = scope.trim();
    let trimmed_content = content.trim();
    if trimmed_scope.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }
    if trimmed_content.is_empty() {
        return Err(AppError::Validation("message content is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let sender = format!("operator:{trimmed_scope}");
    writes::broadcast_from_operator(&conn, trimmed_scope, &sender, trimmed_content)
        .map_err(AppError::Operation)
}

/// Send a Ctrl-C (0x03) to every PTY bound to an instance in `scope`. This is
/// the "Stop" button in the Conversation panel — a soft halt that drops each
/// agent's harness back to its shell prompt without killing the process tree.
/// Only PTYs the UI still has a binder resolution for are signalled; externally
/// adopted agents (no bound PTY in this UI session) are skipped by necessity.
///
/// Returns the count of PTYs that received the interrupt. Failures on
/// individual writes are logged but don't abort the fan-out.
#[tauri::command]
pub fn ui_send_sigint_scope(
    binder: State<'_, Binder>,
    manager: State<'_, PtyManager>,
    scope: String,
) -> Result<usize, AppError> {
    let trimmed = scope.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("scope is required".into()));
    }

    let conn = writes::open_rw().map_err(AppError::Operation)?;
    let instance_ids =
        writes::list_scope_instance_ids(&conn, trimmed).map_err(AppError::Operation)?;

    let mut count = 0usize;
    for instance_id in instance_ids {
        let Some(pty_id) = binder.resolved_pty_for(&instance_id) else {
            continue;
        };
        match manager.write_input(&pty_id, &[0x03]) {
            Ok(()) => count += 1,
            Err(err) => eprintln!(
                "[ui_send_sigint_scope] failed to SIGINT pty {pty_id} for instance {instance_id}: {err:?}"
            ),
        }
    }
    Ok(count)
}

/// Kill the OS process backing `instance_id`, then deregister the swarm row.
///
/// This exists because the previous "remove" path (`ui_deregister_instance` /
/// `ui_force_deregister_instance`) only closed PTYs that the current UI session
/// still owned. Instances adopted by an externally-spawned Claude (`flux` in a
/// Terminal.app tab, a `bun test` runner, etc.) left their OS process running
/// after the swarm row was dropped — so the red icon looked like it worked but
/// the bun/claude process continued burning tokens.
///
/// Behaviour:
///   - Load the row to get `pid`. Reject if the row is missing.
///   - If a binder resolution exists in this UI session, close the PTY via the
///     daemon first (best-effort, errors swallowed — the user's intent is
///     unambiguous).
///   - If `pid > 0` and `pid != current process pid`, `kill -TERM <pid>`; then
///     wait 1500 ms; then `kill -0 <pid>` to see if it's still alive; if so,
///     `kill -KILL <pid>`. Errors are logged but do not block deregistration —
///     a race where the process already exited (pid=0 / ESRCH) is expected.
///   - Always call `writes::deregister_instance` so the row and its cascading
///     cleanup (locks, queued messages, claimed tasks) happen even if the kill
///     syscall fails.
///   - Unconditionally drop the binder mapping.
///
/// The frontend gates this behind the red-icon confirm dialog.
#[tauri::command]
pub async fn ui_kill_instance(
    binder: State<'_, Binder>,
    instance_id: String,
) -> Result<(), AppError> {
    let trimmed = instance_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("instance_id is required".into()));
    }
    kill_target_internal(
        &binder,
        KillTarget::BoundInstance {
            instance_id: trimmed.to_owned(),
        },
    )
    .await?;
    Ok(())
}
