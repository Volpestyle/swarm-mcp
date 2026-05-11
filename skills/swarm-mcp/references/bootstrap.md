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

- Sessions in the same scope can see each other, message each other, and share tasks, locks, and KV.
- Sessions in different scopes are different swarms.
- Use a different scope only for a separate swarm.
- Do not use scope to split frontend/backend inside one repo; keep one shared scope and use label tokens like `team:frontend` and `team:backend`.

If omitted, the server defaults to the detected git root, or the provided directory when no git root exists.

### `file_root`

The canonical base path used for resolving relative file paths.

Use it when:

- the session is running in a disposable worktree
- multiple worktrees should share one logical file tree
- locks should point at a stable checkout instead of a temp path

If you are working directly in the shared checkout, `file_root` can usually match `directory`.

### `label`

Free-form identity text for the session.

Recommended convention:

- `identity:work provider:codex-cli role:planner`
- `identity:work provider:codex-cli role:implementer`
- `identity:work provider:claude-code role:reviewer`

The `identity:` token should match the launcher/config root (`identity:work` or `identity:personal`). The `role:` token is optional. No `role:` token means the session is a generalist.

## First Read After Register

After `register`, call `bootstrap`. It returns your current instance, peers, unread messages, task snapshot, and configured work tracker metadata in one yield-checkpoint read.

Use focused reads only when you need one part of the surface:

- `whoami` for your identity only
- `list_instances` for peers only
- `poll_messages` for unread messages only
- `list_tasks` for tasks only

Handle unread messages before claiming new work. If your live interface receives a peer wake prompt, call `bootstrap` or `poll_messages` immediately; the live prompt is only a nudge, and unread swarm messages are the source of truth.

If `bootstrap.peers` is empty, no peer can collide; the integration plugin's peer-lock check has nothing to block on, and you have no reason to take a manual `lock_file` either. Re-check peers at your next yield checkpoint, or from `instance_changes` if you are already monitoring with `wait_for_activity` for another reason.

Use `get_file_lock` to inspect whether a peer is holding a file. Reach for `lock_file` only when you need a critical section wider than a single write tool call — multi-step Read→Edit, multi-file refactor, or planned reservation. Plugin-supported runtimes enforce peer-held locks at write time; see `SKILL.md` ("Locking") for the full doctrine.
