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
    model::{AppError, InstanceStatus, SavedLayout},
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
        .map_err(|err| AppError::Operation(format!("failed to enumerate offline instances: {err}")))?
        .collect::<Result<_, _>>()
        .map_err(|err| AppError::Operation(format!("failed to read offline instance row: {err}")))?;
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
