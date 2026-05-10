# Identity and Auth Boundaries

Auth separation is a core pillar of the native agent stack. Work and personal workers must be separated by launcher profile, config root, MCP server names, OAuth/token storage, and swarm labels. The model should not have to remember which account is safe to use; the wrong account's tools should not be loaded in that process.

> **The hard boundary is the launched process and its config root, not a label.** `clawd`/`codex`/`opencode`/`hermesw` (work) and `clowd`/`cdx`/`opc`/`hermesp` (personal) start a worker against a specific config root, which loads only same-identity account-scoped MCPs. Swarm `identity:` labels are routing and audit metadata; they do not authorize anything by themselves. Anything that needs strong account isolation must come from the launcher and config root, not from a label.

## Native Identities

| Identity | Claude launcher | Codex launcher | OpenCode launcher | Hermes launcher | Purpose |
|---|---|---|---|---|---|
| `work` | `clawd` / `claude` | `codex` | `opencode` | `hermesw` | Company repos, work Linear, work Figma, Atlassian, Datadog |
| `personal` | `clowd` | `cdx` | `opc` | `hermesp` | Personal repos, personal Linear, personal Figma |

Launchers choose identity before the agent starts. Do not ask a running agent to switch identities mid-session.

Spawner backends must choose one of these launchers when creating a worker.
The current golden-path spawner is herdr; `swarm-ui` remains a legacy/fallback
backend and its launcher support may lag the table above. The Hermes plugin
(see `integrations/hermes/`) auto-registers from inside an already-running
Hermes session, so most Hermes workers will be adopted rather than spawned
through `ui spawn`.

## Worker and Lead Aliases

For interactive local use, keep paired worker/lead launcher functions for the
same identity. The worker launcher selects the account/config root only. The
lead launcher selects the same account/config root and also enables gateway
behavior plus a discoverable planner role.

Launcher functions should source identity env files instead of embedding all
configuration inline. The repo ships templates in [`../env/`](../env/):

```sh
mkdir -p ~/.config/swarm-mcp
cp /path/to/swarm-mcp/env/work.env.example ~/.config/swarm-mcp/work.env
cp /path/to/swarm-mcp/env/personal.env.example ~/.config/swarm-mcp/personal.env
```

Edit those local files with your config roots and configured work tracker. They
must contain routing metadata only, not tokens.

Personal example:

```sh
_swarm_run() (
  local env_file="$1"
  shift
  set -a
  source "$env_file"
  set +a
  "$@"
)

clowd() { _swarm_run "$HOME/.config/swarm-mcp/personal.env" claude --enable-auto-mode "$@"; }
cdx() { _swarm_run "$HOME/.config/swarm-mcp/personal.env" command codex "$@"; }
```

Lead functions add runtime-specific gateway vars after sourcing the same env
file. See [`../env/launchers.zsh.example`](../env/launchers.zsh.example) for a
complete zsh example.

In this convention:

- `clowd` / `cdx` are personal workers.
- `clowdl` / `cdxl` are personal leads.
- `SWARM_<runtime>_ROLE=gateway` is the lead/conductor behavior.
- `SWARM_<runtime>_AGENT_ROLE=planner` is the swarm routing label workers use
  to discover the lead.
- `SWARM_WORK_TRACKER` in the sourced env file is the configured same-identity
  tracker policy published to swarm KV by hooks.
- Lead aliases should register labels containing both `mode:gateway` and
  `role:planner`; `mode:gateway` is not a role, it is behavior metadata.

Do not treat the `identity:` label as the permission boundary. The permission
boundary is still the launched process and its config root. For non-interactive
launchers that do not expand shell aliases, inject the same environment
variables directly.

## Config Roots

| Runtime | Work config root | Personal config root |
|---|---|---|
| Claude Code | default `~/.claude.json` / `~/.claude` | `CLAUDE_CONFIG_DIR=~/.claude-personal` |
| Codex | `~/.codex` | `CODEX_HOME=~/.codex-personal` |
| OpenCode | `~/.config/opencode` | `OPENCODE_CONFIG_DIR=~/.config/opencode-personal` |
| Hermes | default `~/.hermes` | Hermes profile, for example `~/.hermes/profiles/personal` |

Each root owns its own MCP auth state and should be able to run without reading the other identity's credentials.

## MCP Naming

Use identity-suffixed MCP server names. Avoid ambiguous globals like `figma`, `linear`, or `linear-server` once both identities exist.

The suffix is for config clarity, operator visibility, and cross-process routing. It is not authorization by itself. A launched identity should only load same-identity account-scoped MCP servers; do not put both `*_work` and `*_personal` account tools in one worker process just because their names are explicit.

Work examples:

```text
figma_work
linear_work
atlassian_work
```

Personal examples:

```text
figma_personal
linear_personal
github_personal
```

If a provider only exists on one side, still use the suffix when it carries account authority.

## Worker Rules

Workers should receive an identity label in their swarm registration, for example:

```text
identity:work provider:codex role:implementer
identity:personal provider:opencode role:researcher
```

Runtime rules:

- Use only MCP tools matching your `identity:` label.
- If `identity:work`, never call `*_personal` tools.
- If `identity:personal`, never call `*_work` tools.
- If a task references the other identity's resource, stop and ask for a relaunch or handoff under the correct profile.
- Do not copy tokens between config roots.
- Prefer OAuth-managed remote MCP auth over raw bearer tokens in JSON config.

## Enforcement Model

The hard boundary is the process launched from the right profile:

- `work` launchers read work config roots and load only work account MCPs.
- `personal` launchers read personal config roots and load only personal account MCPs.
- Identity labels such as `identity:work` and `identity:personal` help planners, gateways, and reviewers route and audit work, but `swarm-mcp` does not enforce account authorization from labels.

If work and personal coordination data must also be isolated, use separate `SWARM_DB_PATH` values or separate OS users. A `scope` or `identity:` label alone is not a credential boundary; every same-user process with access to the shared swarm database can read and write coordination state.

## Stack Routing

Hermes and swarm planners should route work by repo and task identity:

| Signal | Identity |
|---|---|
| Work repo path, work Linear issue, Atlassian/Jira URL, company Figma file | `work` |
| Personal repo path, personal Linear issue, personal Figma file | `personal` |

Dispatch flow:

1. Determine `identity` from the originating repo, tracker, or explicit user instruction.
2. Select the work tracker from repo/scope/launcher/operator config for that identity.
3. Read the hook-published `config/work_tracker/<identity>` KV row or `bootstrap.work_tracker`.
4. Create or link the tracker item only if the configured same-identity MCP is available.
5. Do not substitute a different loaded tracker MCP when the configured tracker is missing or ambiguous.
6. Create the swarm task with an `identity:<work|personal>` label in task context or assignee label matching.
7. Spawn a worker through the matching launcher (`codex` vs `cdx`, `opencode` vs `opc`, `claude`/`clawd` vs `clowd`).
8. Worker uses only same-identity MCPs.

## Figma and Linear

Figma and Linear are both account-scoped sources of truth. Treat them like production credentials:

- Work design tasks use `figma_work` and `linear_work`.
- Personal design tasks use `figma_personal` and `linear_personal`.
- Workers may update Linear for durable human-facing work records, but they use swarm-mcp for live coordination.
- Workers may create or update Figma artifacts only in the matching identity.

Linear is an example of a configured account-scoped work tracker. If a repo/scope config chooses Jira, GitHub Issues, or another tracker, use that configured same-identity MCP instead. Available MCP tools are a validation step, not the source of tracker selection.


## Design Capability Routing

Hermes may have direct account-scoped design MCPs, but the Hermes MCP list is not the full design capability surface of the native-agent stack. A Hermes gateway or planner can route design work to external workers whose launcher/config root owns stronger remote Figma or Linear auth.

Use direct Hermes design MCPs for local, selection-based work that the current profile can safely access. For example, `figma_personal` in Hermes may point at Figma Desktop MCP and is suitable for reading selected designs, screenshots, metadata, variables, FigJam context, and implementation guidance.

Use an external design worker when the task needs remote-only Figma capabilities, such as design-library search, write-to-canvas, create-new-file or code-to-canvas flows, or remote OAuth support unavailable in Hermes itself. Route through the matching launcher and identity:

- Personal design workers: `opc`, `cdx`, or `clowd`, using `figma_personal` / `linear_personal` in that worker config.
- Work design workers: `opencode`, `codex`, or `claude`/`clawd`, using `figma_work` / `linear_work` in that worker config.

Swarm tasks for design work should state the expected MCP surface explicitly. Example: `identity:personal; use figma_personal and linear_personal; if remote-only Figma tools are required, spawn an opc/cdx/clowd design worker with remote Figma MCP auth.` The durable work contract lives in swarm tasks/messages; direct pane prompts should only wake workers to read that contract.

## Security Notes

Raw bearer tokens in agent config are fragile: they are easy to leak through config inspection, shell history, or logs. Prefer OAuth blocks or secret-store-backed env injection. If a token is printed in logs or tool output, rotate it before continuing to use that account.

Product language: account auth separation is physical, not aspirational. The correct launcher creates a worker that can only see the correct account-scoped tools. Coordination visibility follows the chosen swarm database and OS-user boundary.
