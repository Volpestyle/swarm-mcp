# Identity Boundary Audit (VUH-43)

Audit of the deployed launcher profiles, config roots, coordinator DB, herdr socket, and account-scoped MCP configs on `darwin/jamesvolpe` as of 2026-05-13, measured against the doctrine in [`identity-boundaries.md`](./identity-boundaries.md).

## TL;DR

- **One profile is deployed: `default`.** No `personal`/`work` split exists on this machine.
- The single-profile starter (`env/default.env.example`) is an allowed shape per doctrine — but several MCP servers and one socket path **already use ambiguous global names**, so adding a second identity later cannot be a drop-in operation; it requires renames in every runtime config root.
- Two latent inconsistencies in the deployed `default` profile are surfaced as follow-ups: a herdr-socket path that Hermes ignores, and a coordinator DB path that does not match the example's `~/.swarm-mcp-<profile>/` convention.

## Method

Read-only inventory. Sources consulted:

- Doctrine: `docs/identity-boundaries.md`, `env/README.md`, `env/launchers.zsh.example`, `env/default.env.example`.
- Deployed shell wiring: `~/.zshrc` → `~/.config/swarm-mcp/launchers.zsh` → repo `env/launchers.zsh.example`.
- Deployed profile env file: `~/.config/swarm-mcp/default.env`.
- Per-runtime MCP configs: `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.hermes/config.yaml`.
- Filesystem existence checks for the per-identity roots called out by doctrine (`~/.claude-personal`, `~/.codex-personal`, `~/.config/opencode-personal`, `~/.hermes/profiles/{personal,work}`, `~/.swarm-mcp-{personal,work}`).
- `~/.local/bin/` listing for launcher binaries; `~/.config/herdr/` (symlink to `~/dotfiles/config/herdr`).

The auto-mode classifier blocked directory listings of `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.hermes/profiles/default`, and `~/.swarm-mcp*`, so this audit reads named files rather than enumerating each root. The findings below are conservative for that reason: a hidden file or extra MCP block inside one of those roots would not appear here.

## Deployed Profiles

| Profile env file | Identity | Coordinator DB | Herdr socket | Launcher aliases declared |
|---|---|---|---|---|
| `~/.config/swarm-mcp/default.env` | `default` | `$HOME/.swarm-mcp/swarm.db` | `$HOME/.config/herdr/sessions/default/herdr.sock` | `claude`, `codex`, `opencode`, `hermes` (workers); `clowdg`, `codexg` (leads); `herdr` |

No `personal.env`, `work.env`, or other profile env files exist in `~/.config/swarm-mcp/`. Auto-discovery in `env/launchers.zsh.example` therefore materializes shell functions only for the `default` profile.

The deployed worker aliases shadow the canonical binary names (`claude`, `codex`, `opencode`, `hermes`); each one resolves to a shell function that sources `default.env` and then `command <binary>`. The lead aliases (`clowdg`, `codexg`) and the herdr alias (`herdr`) are profile-distinct.

## Per-Runtime Config Roots

| Runtime | Config root (deployed) | Doctrine work root | Doctrine personal root | Status |
|---|---|---|---|---|
| Claude Code | `~/.claude` (env: `CLAUDE_CONFIG_DIR=$HOME/.claude`) | `~/.claude` (default) | `~/.claude-personal` | Only the default root exists. `~/.claude-personal` absent. |
| Codex | `~/.codex` (env: `CODEX_HOME=$HOME/.codex`) | `~/.codex` | `~/.codex-personal` | Only the default root exists. `~/.codex-personal` absent. |
| OpenCode | `~/.config/opencode` (env: `OPENCODE_CONFIG_DIR=$HOME/.config/opencode`) | `~/.config/opencode` | `~/.config/opencode-personal` | Only the default root exists. `~/.config/opencode-personal` absent. |
| Hermes | `~/.hermes` (env: `HERMES_HOME=$HOME/.hermes`) | `~/.hermes` | `~/.hermes/profiles/personal` | Top-level root exists. `~/.hermes/profiles/` contains only `default/`; no `personal/` or `work/` subprofile. |

Each runtime is currently single-rooted under the `default` identity. This is an allowed shape per `env/README.md` ("Single profile — one identity, one DB, one set of MCP roots. Pick any name and stop.").

## MCP Servers Loaded per Runtime

These MCP servers were observed in each runtime's primary config. Identity suffixing is doctrine for "once both identities exist." None of the four runtimes use suffixes today; account-scoped names (`figma`, `linear`, `github`, `obsidian`, `swarm`) are global.

| Runtime | MCP server | Identity-suffix? | Notes |
|---|---|---|---|
| Claude Code (`~/.claude/settings.json`) | `swarm@swarm-mcp` (plugin enabled) | no | Other MCP tooling exposed via marketplace plugins (figma, frontend-design, language LSPs, ralph-loop, commit-commands). The settings file enables the plugin set; account-scoped MCP servers live inside the plugin manifests rather than at the settings root. |
| Codex (`~/.codex/config.toml`) | `github`, `obsidian`, `openaiDeveloperDocs`, `figma`, `linear`, `excalidraw`, `swarm` | no | `figma` → `https://mcp.figma.com/mcp`. `linear` → `https://mcp.linear.app/mcp`. `swarm` → `bun run /Users/jamesvolpe/web/swarm-mcp/src/index.ts` (no env block — inherits from process). `github` uses `GITHUB_MCP_TOKEN` env var. |
| OpenCode (`~/.config/opencode/opencode.json`) | `figma`, `linear` | no | Both remote MCPs configured with `oauth: {}`. No swarm MCP block in opencode.json (worker reaches swarm-mcp via the launcher env, not via a runtime MCP entry). |
| Hermes (`~/.hermes/config.yaml`) | `swarm`, `figma`, `linear` | no | `swarm` block pins explicit env: `AGENT_IDENTITY=default`, `SWARM_DB_PATH=/Users/jamesvolpe/.swarm-mcp/swarm.db`, `SWARM_MCP_SCOPE=/Users/jamesvolpe/volpestyle`, `SWARM_MCP_ROOTS=/Users/jamesvolpe/volpestyle:/Users/jamesvolpe/herdr`, `HERDR_SOCKET_PATH=/Users/jamesvolpe/.config/herdr/herdr.sock`. |

## CONFORMS / DIVERGES

| Doctrine rule | Status | Evidence |
|---|---|---|
| The hard boundary is the launched process and its config root, not a label. | CONFORMS | Each launcher alias sources its profile env, exports `AGENT_IDENTITY`/`SWARM_IDENTITY` before exec, and pins `*_CONFIG_DIR`/`CODEX_HOME`/`OPENCODE_CONFIG_DIR`/`HERMES_HOME`. |
| Profile names are user-defined; single-profile is allowed. | CONFORMS | One `default` profile is the documented single-profile shape (`env/default.env.example`). |
| Each profile owns a coordinator DB path (`SWARM_DB_PATH`). | CONFORMS (with caveat — see below) | `default.env` sets `SWARM_DB_PATH=$HOME/.swarm-mcp/swarm.db`. Hermes's `mcp_servers.swarm.env` pins the same path. |
| Each profile owns a herdr socket (`HERDR_SOCKET_PATH`). | DIVERGES | `default.env` sets `…/sessions/default/herdr.sock`, but Hermes's swarm-MCP env hardcodes `…/herdr.sock` (no `sessions/default/` segment). `~/.config/herdr/sessions/` does not exist on disk. Hermes-launched swarm processes will not see the profile-scoped socket path the rest of the profile env advertises. See follow-up #1. |
| Each profile owns account-scoped MCP config roots, one per runtime. | CONFORMS | `default.env` sets all four runtime roots; each runtime config lives under its declared root. |
| Each profile owns a set of launcher aliases. | CONFORMS | Generator + auto-discovery produces shell functions; lead aliases set `SWARM_*_ROLE=gateway`/`SWARM_*_AGENT_ROLE=planner`. |
| Each profile owns an `identity:<profile>` token. | CONFORMS | `AGENT_IDENTITY=default`/`SWARM_IDENTITY=default` exported by `default.env` and by the Hermes swarm-MCP `env` block. |
| Worker label includes `identity:<profile>`. | CONFORMS | This instance is registered with `identity:default role:implementer …` (visible in the SessionStart label). |
| Workers may update Linear for durable work records, but use swarm-mcp for live coordination; Workers may create/update Figma artifacts only in the matching identity. | CONFORMS (vacuously) | Only one identity exists, so cross-identity Linear/Figma use is impossible by construction. |
| Avoid ambiguous globals like `figma`, `linear`, `linear-server` once both identities exist. | LATENT DIVERGE | Today there is no second identity, so this rule is not yet violated. But all four runtimes name their MCP servers ambiguously (`figma`, `linear`, `github`, `obsidian`, `swarm`). Adding a `work` identity later requires coordinated rename in `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.hermes/config.yaml`, and any Claude plugin manifests. See follow-up #2. |
| If `identity:work`, never call `*_personal` tools, and vice versa. | N/A | No suffixed tools exist yet. |
| Each per-profile coordinator DB convention is `~/.swarm-mcp-<profile>/swarm.db`. | DIVERGES (cosmetic) | `default.env` uses `~/.swarm-mcp/swarm.db` instead of `~/.swarm-mcp-default/swarm.db`. The `~/.swarm-mcp-default/` directory exists but is unused; `~/.swarm-mcp/` is the live one. See follow-up #3. |
| Launchers also set identity-scoped herdr sockets (e.g. `~/.config/herdr/sessions/<profile>/herdr.sock`). | DIVERGES at runtime | As above; profile env declares the right path, Hermes does not honor it. |
| Hermes needs `AGENT_IDENTITY` + `SWARM_DB_PATH` directly on the swarm MCP server entry (Hermes may scrub parent env). | CONFORMS | `~/.hermes/config.yaml` `mcp_servers.swarm.env` carries both. |
| Use identity-suffixed MCP server names for `figma_work`/`figma_personal`/etc. | LATENT DIVERGE | Same as the ambiguous-globals row. |
| Do not copy tokens between config roots. | NOT VERIFIED (read access blocked) | Could not enumerate `auth.json`/`.credentials` inside `~/.claude`, `~/.codex`, `~/.config/opencode`, or `~/.hermes/profiles/default`. See "Out of scope" below. |
| Prefer OAuth over raw bearer tokens. | PARTIAL | OpenCode `figma`/`linear` use `oauth: {}`. Codex `github` uses `bearer_token_env_var = "GITHUB_MCP_TOKEN"` (env-injected; not a raw token in JSON — preferred over inline tokens, but doctrine prefers OAuth where supported). |

## Other observations

- **Hermes scope subset:** Hermes's swarm-MCP env block scopes the worker to `SWARM_MCP_SCOPE=/Users/jamesvolpe/volpestyle` and `SWARM_MCP_ROOTS=/Users/jamesvolpe/volpestyle:/Users/jamesvolpe/herdr`. `default.env` (which non-Hermes launchers source) sets `SWARM_MCP_DEFAULT_ROOTS=$HOME`. The `default` profile therefore has two different filesystem scopes depending on which runtime starts the worker. This is consistent with `docs/identity-defense-in-depth.md` (process-internal fences layered on top of the launcher boundary) but is worth calling out because a non-Hermes worker launched under `default` sees the whole home dir, while a Hermes worker sees only `volpestyle`/`herdr`. See follow-up #4.
- **`~/.config/herdr` is a symlink** to `~/dotfiles/config/herdr`. `config.toml`, `session.json`, and the `herdr.sock`/`herdr-client.sock` all live in dotfiles. Profile-scoped sockets at `~/.config/herdr/sessions/<profile>/…` would land inside the dotfiles tree; if that's not desired the symlink target needs revisiting before any second profile is added.
- **No `~/.swarm-mcp-personal`, `~/.swarm-mcp-work`** directories exist. `~/.swarm-mcp-default/` exists and is unused by `default.env`. If/when a second profile is added the cleanest move is to migrate `default` to the `~/.swarm-mcp-default/` directory and free `~/.swarm-mcp/` (which has no identity suffix and risks being confused for "all profiles").
- **Lead aliases declared but no profile-distinct worker aliases.** `default.env` shadows the binary names for the worker aliases (`SWARM_HARNESS_CLAUDE=claude`), so the bare binary and the swarm-managed launcher are the same word; only the lead aliases (`clowdg`, `codexg`) are visibly profile-bound. This is intentional per the example file ("binary-name shadowing is safe because the generator uses `command claude` internally"), and works as long as the shell function takes effect. Worth re-verifying once a second profile is added — collisions across profiles on `claude`/`codex`/`opencode`/`hermes` would silently bind to whichever profile was auto-discovered last.

## Out of scope (couldn't audit)

The auto-mode classifier in this Claude Code session blocked directory listings under `~/.claude`, `~/.codex`, `~/.config/opencode`, and `~/.hermes/profiles/default`. This audit therefore did not:

- Enumerate per-runtime `auth.json` / credential files to confirm there is no cross-identity token leakage. (Not possible to leak in the single-profile shape, but would matter the moment a second profile is added.)
- Enumerate Claude Code plugin manifests under `~/.claude/plugins/` for hidden MCP server declarations (figma, swarm, language LSPs) — these are pulled in via `enabledPlugins` in `settings.json` and therefore inherit their identity from the launching process, but the actual server commands and any env blocks were not inspected.
- Inspect `~/.hermes/profiles/default/` internals for plugin or MCP overrides that diverge from `~/.hermes/config.yaml`.

The single-profile shape means none of these blocked surfaces can host a cross-identity violation today (only one identity exists). But they should be inspectable from an audit context; see follow-up #5.

## Follow-ups (suggested Linear tickets)

1. **Reconcile Hermes herdr socket path with the profile env** — either drop the `sessions/<profile>/` segment from `env/default.env.example` and `env/profile.env.example` so all runtimes use `~/.config/herdr/herdr.sock`, or update Hermes's `mcp_servers.swarm.env.HERDR_SOCKET_PATH` (and any LaunchAgent block) to honor the profile-scoped path. Related: `docs/identity-boundaries.md` already promises profile-scoped sockets to "avoid relying on a sandboxed `$HOME` or the default host profile socket."
2. **Identity-suffix the MCP server names before a second profile is added** — rename `figma`, `linear`, `github`, `obsidian`, `swarm` to `figma_default`, `linear_default`, etc. in `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.hermes/config.yaml`, and the relevant Claude plugin manifests. Dovetails with VUH-44 (startup diagnostics) and VUH-47 (visibility smoke tests).
3. **Migrate `default` coordinator DB to `~/.swarm-mcp-default/swarm.db`** — the env example's pattern is `~/.swarm-mcp-<profile>/swarm.db`. Today `default.env` writes to `~/.swarm-mcp/swarm.db` and the `~/.swarm-mcp-default/` dir is dead. Pick one and align; current state guarantees confusion once a second profile is added because `~/.swarm-mcp/` will be naturally read as "shared" rather than "default-only."
4. **Document the Hermes scope subset (`SWARM_MCP_SCOPE`/`SWARM_MCP_ROOTS`)** — note in `docs/identity-boundaries.md` or `docs/identity-defense-in-depth.md` that Hermes workers in the `default` profile see only `volpestyle`+`herdr`, while non-Hermes workers see all of `$HOME`. Clarify which is the intended sandbox.
5. **Add an auditor-friendly read path for per-runtime auth state** — separate from the live process boundary, an operator should be able to dump "what MCP servers does runtime X load under profile Y, with what auth strategy" without poking around in each config root by hand. Could be a swarm-mcp CLI subcommand (`swarm-mcp audit-profile <profile>`) that snapshots normalized data into the swarm KV; supports VUH-43 reruns and VUH-47 smoke tests.

Items 1–3 are concrete drift that block clean second-profile addition. Items 4–5 are doctrine/tooling polish.

## Cross-references

- VUH-42 — Identity/auth boundary hardening track (parent).
- VUH-44 — Startup diagnostics for identity/config/MCP mismatches (would catch follow-ups #1 and #2 automatically).
- VUH-47 — Work/personal MCP visibility smoke tests (consumes #2).
- VUH-48 — Isolated `SWARM_DB_PATH` profiles (consumes #3).
- VUH-50 — `hermesp` launcher rooted at `~/volpestyle` (would land follow-up #4 in practice when a personal Hermes profile is added).
- VUH-52 — Hermes MCP servers inherit filesystem boundary (overlaps with #4).
