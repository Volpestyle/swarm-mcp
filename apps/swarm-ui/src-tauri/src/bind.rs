use std::collections::HashMap;
use std::sync::RwLock;

use serde::Serialize;
use tauri::State;

use crate::model::Instance;

#[derive(Debug, Clone, Serialize)]
pub struct BindEvent {
    pub token: String,
    pub instance_id: String,
    pub pty_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BindingState {
    pub pending: Vec<(String, String)>,
    pub resolved: Vec<(String, String)>,
}

#[derive(Default)]
struct BindingMaps {
    pending: HashMap<String, String>,
    resolved: HashMap<String, String>,
}

pub struct Binder {
    inner: RwLock<BindingMaps>,
}

impl Binder {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(BindingMaps::default()),
        }
    }

    pub fn register_pending(&self, token: &str, pty_id: &str) -> Result<(), String> {
        self.inner
            .write()
            .map_err(|_| "binder lock poisoned".to_owned())?
            .pending
            .insert(token.to_owned(), pty_id.to_owned());
        Ok(())
    }

    /// Record a resolved instance↔PTY binding without waiting for the
    /// launch-token label matching dance. Used by the UI-owned pre-creation
    /// path in `launch.rs::spawn_shell` where the UI already knows the
    /// instance id at spawn time.
    pub fn bind_immediate(&self, instance_id: &str, pty_id: &str) -> Result<(), String> {
        self.inner
            .write()
            .map_err(|_| "binder lock poisoned".to_owned())?
            .resolved
            .insert(instance_id.to_owned(), pty_id.to_owned());
        Ok(())
    }

    /// Look up the PTY currently bound to `instance_id`, if any. Callers use
    /// this to refuse double-binds (e.g. respawning an instance that already
    /// has a live PTY in this UI session).
    #[must_use]
    pub fn resolved_pty_for(&self, instance_id: &str) -> Option<String> {
        self.inner.read().ok()?.resolved.get(instance_id).cloned()
    }

    /// Remove a resolved binding. Called on PTY exit so stale entries don't
    /// linger in the snapshot after the session is gone.
    pub fn unbind(&self, instance_id: &str) {
        if let Ok(mut inner) = self.inner.write() {
            inner.resolved.remove(instance_id);
        }
    }

    /// Attempts to match pending launch tokens against instance labels.
    ///
    /// Returns an empty list if the lock is poisoned. This is called from an
    /// event callback where error propagation is not possible.
    #[must_use]
    pub fn try_resolve(&self, instances: &[Instance]) -> Vec<BindEvent> {
        let Ok(mut inner) = self.inner.write() else {
            return Vec::new();
        };

        let mut events = Vec::new();
        for instance in instances {
            let Some(label) = instance.label.as_deref() else {
                continue;
            };

            let Some(token) = extract_launch_token(label) else {
                continue;
            };

            let Some(pty_id) = inner.pending.remove(token) else {
                continue;
            };

            let instance_id = instance.id.clone();
            inner.resolved.insert(instance_id.clone(), pty_id.clone());
            events.push(BindEvent {
                token: token.to_owned(),
                instance_id,
                pty_id,
            });
        }

        events
    }

    #[must_use]
    pub fn snapshot(&self) -> BindingState {
        let Ok(inner) = self.inner.read() else {
            return BindingState {
                pending: Vec::new(),
                resolved: Vec::new(),
            };
        };

        let mut pending = inner
            .pending
            .iter()
            .map(|(token, pty_id)| (token.clone(), pty_id.clone()))
            .collect::<Vec<_>>();
        pending.sort_unstable();

        let mut resolved = inner
            .resolved
            .iter()
            .map(|(instance_id, pty_id)| (instance_id.clone(), pty_id.clone()))
            .collect::<Vec<_>>();
        resolved.sort_unstable();

        BindingState { pending, resolved }
    }
}

fn extract_launch_token(label: &str) -> Option<&str> {
    label
        .split_whitespace()
        .find_map(|token| token.strip_prefix("launch:"))
}

#[tauri::command]
#[must_use]
pub fn get_binding_state(binder: State<'_, Binder>) -> BindingState {
    binder.snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::InstanceStatus;

    fn test_instance(id: &str, label: Option<&str>) -> Instance {
        Instance {
            id: id.into(),
            scope: "default".into(),
            directory: "/tmp".into(),
            root: "/tmp".into(),
            file_root: "/tmp".into(),
            pid: 1,
            label: label.map(Into::into),
            registered_at: 0,
            heartbeat: 0,
            status: InstanceStatus::Online,
            adopted: true,
        }
    }

    #[test]
    fn extract_token_from_label() {
        assert_eq!(
            extract_launch_token("role:planner launch:abc123 provider:oc"),
            Some("abc123")
        );
    }

    #[test]
    fn extract_token_missing() {
        assert_eq!(extract_launch_token("role:planner provider:oc"), None);
    }

    #[test]
    fn extract_token_empty_label() {
        assert_eq!(extract_launch_token(""), None);
    }

    #[test]
    fn binder_register_and_resolve() {
        let binder = Binder::new();
        binder.register_pending("tok1", "pty-1").unwrap();

        let instances = vec![test_instance("inst-1", Some("role:planner launch:tok1"))];
        let events = binder.try_resolve(&instances);

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].token, "tok1");
        assert_eq!(events[0].instance_id, "inst-1");
        assert_eq!(events[0].pty_id, "pty-1");

        let state = binder.snapshot();
        assert!(state.pending.is_empty());
        assert_eq!(state.resolved.len(), 1);
    }

    #[test]
    fn binder_no_match_without_token() {
        let binder = Binder::new();
        binder.register_pending("tok1", "pty-1").unwrap();

        let instances = vec![test_instance("inst-1", Some("role:planner"))];
        let events = binder.try_resolve(&instances);

        assert!(events.is_empty());
        assert_eq!(binder.snapshot().pending.len(), 1);
    }

    #[test]
    fn binder_no_match_without_label() {
        let binder = Binder::new();
        binder.register_pending("tok1", "pty-1").unwrap();

        let instances = vec![test_instance("inst-1", None)];
        let events = binder.try_resolve(&instances);

        assert!(events.is_empty());
    }

    #[test]
    fn binder_snapshot_empty() {
        let binder = Binder::new();
        let state = binder.snapshot();
        assert!(state.pending.is_empty());
        assert!(state.resolved.is_empty());
    }
}
