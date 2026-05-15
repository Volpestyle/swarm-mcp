# Identity and Auth Boundaries

Workers from different isolation boundaries must be separated by launcher profile, config root, MCP server names, OAuth/token storage, and swarm labels. The model should not have to remember which account is safe to use; the wrong account's tools should not be loaded in that process.

> **The hard boundary is the launched process and its config root, not a label.** Each profile's launcher starts a worker against a specific config root, which loads only same-identity account-scoped MCPs. Swarm `identity:` labels are routing and audit metadata; they do not authorize anything by themselves. Anything that needs strong account isolation must come from the launcher and config root, not from a label.

## Profiles

A swarm-mcp "profile" is the canonical isolation boundary. Profile names are user-defined slugs — swarm-mcp has no reserved names. You can run one profile (`main`), two (`work`, `personal`), three (`work`, `personal`, `client-x`), or however many independent identities you need. Each profile owns:

- A coordinator DB path (`SWARM_DB_PATH`) — keeps coordination state isolated.
- A herdr socket (`HERDR_SOCKET_PATH`) — keeps live pane control isolated.
- Account-scoped MCP config roots (one per runtime) — keeps OAuth/tokens isolated.
- A set of launcher aliases — your shell function names for that profile's agents (see [`../env/launchers.zsh.example`](../env/launchers.zsh.example) and the `swarm_define_profile` generator).
- An `identity:<profile>` token used on the wire.

### Example: work + personal

This is one concrete example, not a special built-in split. Substitute any profile names that fit your boundaries.

| Profile | Claude launcher | Codex launcher | OpenCode launcher | Hermes launcher | Purpose |
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

Dispatch uses the requester's `identity:` token as the spawn identity, then
reads `SWARM_HARNESS_CLAUDE` / `_CODEX` / `_OPENCODE` / `_HERMES` from the
matching profile env file to resolve the launcher alias. A requester labeled
`identity:client-x` asking for `claude` gets `client-x.env`'s
`SWARM_HARNESS_CLAUDE` alias. The spawned instance label also carries
`identity:<profile>` so future live-worker reuse stays inside the same
boundary.

## Worker, Lead, and Vanilla Launches

Each profile supports three launch shapes for every canonical agent:

| Shape | How you invoke it | What happens at SessionStart |
|---|---|---|
| **Worker** | profile worker alias (`clowd`, `cdx`, …) | Sources profile env, exports `AGENT_IDENTITY`. Registers as `identity:<profile>` worker. |
| **Gateway** | profile lead alias (`clowdg`, `cdxg`, `opcg`, `hermes`, …) | Same as worker plus `SWARM_<RUNTIME>_ROLE=gateway` and a planner agent role. Registers as `identity:<profile> mode:gateway role:planner`. |
| **Vanilla** | the unwrapped binary (`claude`, `codex`, …) | No identity env exported → SessionStart hook **skips registration**, prints a one-line stderr note, exits. The session leaves no DB footprint and is invisible to swarm peers. |

Vanilla is the absence of a launcher — you do not define an alias for it.
The hook detects the absence of `AGENT_IDENTITY` /
`SWARM_<RUNTIME>_IDENTITY` / `SWARM_IDENTITY` and intentionally does not
register. An unlabeled instance would be discoverable from any identity and
defeat the cross-identity boundary; rather than mint a synthetic
`identity:unknown`, the hook simply stays out of the swarm.

The escape hatch is `SWARM_MCP_ALLOW_UNLABELED=1` — set it from a trusted
shell to register an unlabeled session. Use only when you know what you
are doing; the boundary degrades to fail-open for that session.

### Worker and Lead Aliases

For interactive local use, keep paired worker/lead launcher functions for the
same identity. The worker launcher selects the account/config root only. The
lead launcher selects the same account/config root and also enables gateway
behavior plus a discoverable planner role.

Launcher functions should source per-profile env files instead of embedding all
configuration inline. The repo ships templates in [`../env/`](../env/) — start
from `profile.env.example` (generic, one copy per profile) or from
`personal.env.example` / `work.env.example` (pre-filled examples of a common
two-profile pattern):

```sh
mkdir -p ~/.config/swarm-mcp
# Generic — one copy per profile you want:
cp /path/to/swarm-mcp/env/profile.env.example ~/.config/swarm-mcp/<profile>.env
# Or use the pre-filled examples:
cp /path/to/swarm-mcp/env/work.env.example     ~/.config/swarm-mcp/work.env
cp /path/to/swarm-mcp/env/personal.env.example ~/.config/swarm-mcp/personal.env
```

Edit those local files with your config roots and configured work tracker. They
must contain routing metadata only, not tokens.

When coordination data must be isolated too, set a separate `SWARM_DB_PATH` per
identity. The env examples use:

```sh
# work.env
export SWARM_DB_PATH="$HOME/.swarm-mcp-work/swarm.db"

# personal.env
export SWARM_DB_PATH="$HOME/.swarm-mcp-personal/swarm.db"
```

`swarm-mcp` creates the database directory when it starts. Labels and scopes are
not a storage boundary; every process pointed at the same database can read that
database.

Launchers also set identity-scoped herdr sockets, for example:

```sh
# work
export HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/work/herdr.sock

# personal
export HERDR_SOCKET_PATH=/Users/james.volpe/.config/herdr/sessions/personal/herdr.sock
```

Use the matching path for the visible desktop herdr server and that identity's
gateway. This avoids relying on a sandboxed `$HOME` or the default host profile
socket at `~/.config/herdr/herdr.sock`, and it keeps each profile's herdr state
separate.

Use the `swarm_define_profile` generator in `../env/launchers.zsh.example` to
declare a profile's launcher aliases in one line per profile:

```sh
source /path/to/swarm-mcp/env/launchers.zsh.example

# Personal profile example. Workers shadow nothing so the raw binary
# remains available as the vanilla (no-register) launch shape. Hermes
# follows the "short name is the gateway" convention.
swarm_define_profile personal \
    claude=clowd codex=cdx opencode=opc hermes=hermesp-worker \
    claude_lead=clowdg codex_lead=cdxg opencode_lead=opcg hermes_lead=hermesp \
    herdr=herdrp
```

The generator builds `clowd` / `cdx` / `opc` / `hermesp-worker` (workers)
and `clowdg` / `cdxg` / `opcg` / `hermesp` (gateways), plus `herdrp` for
the visible herdr server. Worker functions source the profile env file and
exec the binary. Lead functions do the same plus set
`SWARM_<RUNTIME>_ROLE=gateway` and `SWARM_<RUNTIME>_AGENT_ROLE=planner`,
so the session registers as `mode:gateway role:planner` under the same
identity.

In this convention:

- Worker aliases (whatever you named them) run a per-profile agent.
- Lead aliases run the same agent in gateway/planner mode.
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

| Runtime | Example profile A root | Example profile B root |
|---|---|---|
| Claude Code | default `~/.claude.json` / `~/.claude` | `CLAUDE_CONFIG_DIR=~/.claude-personal` |
| Codex | `~/.codex` | `CODEX_HOME=~/.codex-personal` |
| OpenCode | `~/.config/opencode` | `OPENCODE_CONFIG_DIR=~/.config/opencode-personal` |
| Hermes | default `~/.hermes` | Hermes profile, for example `~/.hermes/profiles/personal` |

Each root owns its own MCP auth state and should be able to run without reading the other identity's credentials.

## MCP Naming

Use identity-suffixed MCP server names. Avoid ambiguous globals like `figma`, `linear`, or `linear-server` once both identities exist.

The suffix is for config clarity, operator visibility, and cross-process routing. It is not authorization by itself. A launched identity should only load same-identity account-scoped MCP servers; do not put multiple profiles' account tools in one worker process just because their names are explicit.

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
identity:client-x provider:codex role:implementer
identity:main provider:opencode role:researcher
```

Runtime rules:

- Use only MCP tools matching your `identity:` label.
- If `identity:client-x`, use only `*_client_x` account-scoped tools.
- If `identity:main`, use only `*_main` account-scoped tools.
- If a task references the other identity's resource, stop and ask for a relaunch or handoff under the correct profile.
- Do not copy tokens between config roots.
- Prefer OAuth-managed remote MCP auth over raw bearer tokens in JSON config.

## Enforcement Model

The hard boundary is the process launched from the right profile:

- Each profile's launchers read that profile's config roots and load only that profile's account MCPs.
- Identity labels such as `identity:client-x` and `identity:main` help planners, gateways, and reviewers route and audit work, but `swarm-mcp` does not enforce account authorization from labels.

If profile coordination data must also be isolated, use separate `SWARM_DB_PATH` values or separate OS users. A `scope` or `identity:` label alone is not a credential boundary; every same-user process with access to the shared swarm database can read and write coordination state.

For an example of layering process-internal fences (write-safe-root env var, allowlist terminal hook) on top of the launcher boundary — useful when both identities share a single user account and you want accidental cross-identity touches blocked loudly — see [`identity-defense-in-depth.md`](./identity-defense-in-depth.md). That doc walks through a personal Hermes example end-to-end and notes how to adapt to other runtimes.

Hermes needs one extra setup step when it launches `swarm-mcp` as an MCP server: Hermes may scrub the parent process environment before spawning MCP children. Put the identity and DB path directly on the `swarm` MCP server entry as well as in the launcher/profile environment:

```yaml
mcp_servers:
  swarm:
    command: bun
    args:
      - run
      - /path/to/swarm-mcp/src/index.ts
    enabled: true
    env:
      AGENT_IDENTITY: personal
      SWARM_DB_PATH: /Users/you/.swarm-mcp-personal/swarm.db
```

Use the matching profile name and DB path for any other profile. Launchd-managed Hermes gateways should also set `AGENT_IDENTITY`, `SWARM_HERMES_IDENTITY`, `HERMES_HOME`, and the same `SWARM_DB_PATH` in the LaunchAgent `EnvironmentVariables` block.

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
6. Create the swarm task with an `identity:<profile>` label in task context or assignee label matching.
7. Spawn a worker through the matching launcher (`codex` vs `cdx`, `opencode` vs `opc`, `claude`/`clawd` vs `clowd`, `hermesw` vs `hermesp`).
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

The correct launcher creates a worker that can only see the correct account-scoped tools. Coordination visibility follows the chosen swarm database and OS-user boundary.
