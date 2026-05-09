# Bootstrap

Use this reference when a session needs to join the swarm correctly.

## Register First

Call `register` before any other swarm tool.

Minimum payload:

```json
{
  "directory": "C:\\repo"
}
```

Useful full payload:

```json
{
  "directory": "C:\\repo",
  "scope": "C:\\repo",
  "file_root": "C:\\repo",
  "label": "identity:work provider:codex-cli role:implementer"
}
```

## Field Meanings

### `directory`

The live working directory for the current session.

### `scope`

The shared swarm boundary.

- Sessions in the same scope can see each other, message each other, and share tasks, locks, annotations, and KV.
- Sessions in different scopes are different swarms.
- Use a different scope only for a separate swarm.
- Do not use scope to split frontend/backend inside one repo; keep one shared scope and use label tokens like `team:frontend` and `team:backend`.

If omitted, the server defaults to the detected git root, or the provided directory when no git root exists.

### `file_root`

The canonical base path used for resolving relative file paths.

Use it when:

- the session is running in a disposable worktree
- multiple worktrees should share one logical file tree
- locks and annotations should point at a stable checkout instead of a temp path

If you are working directly in the shared checkout, `file_root` can usually match `directory`.

### `label`

Free-form identity text for the session.

Recommended convention:

- `identity:work provider:codex-cli role:planner`
- `identity:work provider:codex-cli role:implementer`
- `identity:work provider:claude-code role:reviewer`

The `identity:` token should match the launcher/config root (`identity:work` or `identity:personal`). The `role:` token is optional. No `role:` token means the session is a generalist.

## First Read After Register

After `register`, call:

- `whoami`
- `list_instances`
- `poll_messages`
- `list_tasks`

That gives you current identity, other active sessions, unread coordination requests, and open work.

If `list_instances` returns only you, you can skip per-edit `lock_file` calls until peers join. Watch `instance_changes` from `wait_for_activity` to know when to re-enable locking.

When you do edit a file, `lock_file` is the single coordination call — it returns peer annotations on the file as part of its response, so a separate check is unnecessary.
