// =============================================================================
// ui_commands.rs — Tauri commands for UI-initiated swarm writes
//
// Thin validation layer on top of `writes.rs`, mirroring the validation that
// `src/index.ts` applies before calling the pure helpers in `src/messages.ts`.
// Keeping validation here (not in `writes.rs`) matches the Bun side's split
// between MCP tool handlers and bare DB helpers.
// =============================================================================

use crate::{bind::Binder, model::AppError, writes};
use tauri::State;

/// Clear all message history between two instances in either direction.
/// Triggered by the Inspector's "Clear messages" button on a selected
/// ConnectionEdge. Both ids must be non-empty; no scope check — the UI
/// shows any pair in the current snapshot so the user decides.
#[tauri::command]
pub fn ui_clear_messages(
    instance_a: String,
    instance_b: String,
) -> Result<usize, AppError> {
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
        return Err(AppError::Validation(
            "both task ids are required".into(),
        ));
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
/// remove button on a node whose PTY is already gone — e.g., an orphan
/// row left over from a previous UI session, or a child process the user
/// killed outside the UI.
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
    writes::deregister_instance(&conn, trimmed).map_err(AppError::Operation)?;

    binder.unbind(trimmed);
    Ok(())
}
