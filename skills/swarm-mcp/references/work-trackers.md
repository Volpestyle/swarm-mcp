# Work Trackers

Use this reference when swarm work should be linked to a human-facing tracker such as Linear, Jira, GitHub Issues, or another configured system.

## Current Contract

`swarm-mcp` does not hard-code Linear, Jira, GitHub Issues, or any other tracker. Runtime hooks/plugins publish configured tracker metadata into swarm KV when config is present; tracker use remains skill/config doctrine layered on top of swarm tasks.

Agents must choose trackers in this order:

1. Use the tracker explicitly configured for the repo, swarm scope, launcher profile, or operator instruction.
2. Verify the configured tracker matches the current `identity:<work|personal>` boundary.
3. Verify the matching MCP surface is loaded in this process, such as `linear_work`, `linear_personal`, `jira_work`, or `github_personal`.
4. If the configured same-identity tracker is missing, ask for relaunch, route to a same-identity peer that has it, or continue in swarm only and report that tracker updates were skipped.

Do not infer tracker choice from whichever MCP happens to be available. Do not cross `identity:work` and `identity:personal`. Do not use ambiguous unsuffixed tracker MCP names when identity-specific names exist.

## Config Sources

Hooks read tracker metadata from the first matching source they support:

- identity env files sourced by launcher functions, usually `~/.config/swarm-mcp/work.env` or `~/.config/swarm-mcp/personal.env`
- `SWARM_<runtime>_WORK_TRACKER`, for example `SWARM_CC_WORK_TRACKER` or `SWARM_CODEX_WORK_TRACKER`
- `SWARM_WORK_TRACKER`
- field env vars such as `SWARM_WORK_TRACKER_PROVIDER`, `SWARM_WORK_TRACKER_MCP`, and `SWARM_WORK_TRACKER_TEAM`
- repo-local `.swarm-work-tracker` or `.swarm-work-tracker.json`
- Hermes config `swarm.work_tracker`

The `swarm-mcp` repo ships examples in `env/`. Copy them to a local config directory and edit the copies:

```sh
mkdir -p ~/.config/swarm-mcp
cp /path/to/swarm-mcp/env/work.env.example ~/.config/swarm-mcp/work.env
cp /path/to/swarm-mcp/env/personal.env.example ~/.config/swarm-mcp/personal.env
```

Launcher aliases/functions should source the matching env file before starting the runtime.

The value may be an identity-keyed JSON object:

```json
{
  "work": {
    "provider": "linear",
    "mcp": "linear_work",
    "team": "ENG"
  },
  "personal": {
    "provider": "github_issues",
    "mcp": "github_personal",
    "repo": "Volpestyle/swarm-mcp"
  }
}
```

Or a direct tracker object when the launcher/config root already fixes identity:

```json
{
  "provider": "linear",
  "mcp": "linear_work",
  "team": "ENG"
}
```

Hooks publish the selected object to `config/work_tracker/<identity>` in swarm KV, for example `config/work_tracker/work`. `bootstrap` returns the matching `work_tracker` row for the current instance when present.

## What Goes Where

Use the work tracker for durable human-facing state:

- original request and acceptance criteria
- product priority and links
- durable start, blocked, review, and completion comments
- final summary, test status, PR/commit links, and unresolved risks

Use swarm for live coordination:

- worker heartbeats and presence
- tasks, dependencies, claims, and terminal status
- direct messages and wakeups
- file locks
- short-lived progress, ownership, and plan KV

Do not mirror every swarm event into the tracker.

## Concrete Loop

For non-trivial human-trackable work:

1. Determine the current identity from the launcher/config root and swarm label.
2. Read `bootstrap.work_tracker` or `kv_get("config/work_tracker/<identity>")`.
3. Create or link one tracker item only if the matching MCP is available and authorized.
4. Create swarm task(s) for execution; include the tracker URL or ID in task descriptions or plan KV.
5. Use swarm for assignment, dependencies, locks, messages, review tasks, and structured results.
6. Update the tracker only at durable milestones or when the task contract grants tracker-update authority.
7. If the tracker MCP is unavailable, keep coordination in swarm and include `tracker_update_skipped` in the final result.

## Missing Or Ambiguous Config

If no tracker is configured, use swarm only unless the operator explicitly asks to file or link an issue.

If config points to one tracker but only a different tracker MCP is available, do not substitute it. Ask for a config fix, relaunch under the right identity, or delegate to a peer with the configured MCP.
