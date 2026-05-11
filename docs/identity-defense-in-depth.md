# Defense-in-Depth Within One Identity

[`identity-boundaries.md`](./identity-boundaries.md) covers the hard boundary:
launcher + config root + MCP loadout. That stops the wrong account-scoped
tools from being mounted in a worker process. It does not stop a worker, once
started, from `cd`-ing into a different identity's repo and acting on files
there — the kernel still grants the same OS user access to everything under
`$HOME`.

If you want to keep a personal worker from accidentally touching work
resources (or vice versa) even when both identities share a single user
account, layer process-internal fences on top of the identity boundary. None
of these are a sandbox; together they catch the realistic accidents.

This doc walks one worked example — personal Hermes fenced to a single root.
The pattern generalizes to any runtime that exposes (1) a write-safe-root env
var and (2) a pre-tool-call shell hook protocol. Adapt the runtime-specific
bits as needed.

## The three layers

For a worker fenced to a single root (call it `<SAFE_ROOT>`, e.g.
`~/personal-repos`):

1. **Coordination layer.** Already covered in `identity-boundaries.md`. Swarm
   `identity:<work|personal>` label plus separate `SWARM_DB_PATH` if you want
   coordination data isolated too. Prevents cross-identity `request_task`,
   message routing, and lock collisions.

2. **File-tool layer.** Runtime-native write fence. Hermes ships
   `HERMES_WRITE_SAFE_ROOT`: any built-in write/edit/create tool refuses to
   touch paths outside the configured root. Set it in the launcher so every
   session inherits it.

3. **Terminal layer.** Pre-tool-call shell hook that string-scans the command
   and blocks references to off-root paths. Catches the easy accidents — `cat
   ~/<other-identity-repo>/file`, `cd /Users/you/<other-identity-repo>`,
   `--config=/Users/you/<other-identity-repo>/conf.yaml`. Heuristic only; will
   not stop deliberate obfuscation (base64 decode, env-var indirection,
   `eval`).

The hard guarantee remains the launcher + config root. Defense-in-depth makes
accidents loud and easy to catch, not contain a hostile worker. If your threat
model is a compromised agent process, use a container or jail and mount only
`<SAFE_ROOT>`; the layers below are tuned for ergonomics, not isolation.

## Worked example: personal Hermes fenced to a single root

Assume:

- Personal Hermes profile at `~/.hermes/profiles/personal/`
- Personal safe root at `~/personal-repos`
- Personal launcher named `hermesp` at `~/.local/bin/hermesp`

Substitute your own paths.

### 1. Launcher

`~/.local/bin/hermesp`:

```sh
#!/bin/sh
export AGENT_IDENTITY=personal
export SWARM_HERMES_IDENTITY=personal
export HERMES_HOME="$HOME/.hermes/profiles/personal"
export SWARM_DB_PATH="$HOME/.swarm-mcp-personal/swarm.db"
# File-tool fence: confines Hermes write-class tools to one root.
# Pairs with the allowlist path-fence hook (terminal layer) and the
# identity:personal swarm label (coordination layer).
export HERMES_WRITE_SAFE_ROOT="$HOME/personal-repos"
exec "$HOME/.local/bin/hermes" "$@"
```

Make it executable: `chmod +x ~/.local/bin/hermesp`.

### 2. Allowlist path-fence hook

Save as `~/.hermes/profiles/personal/agent-hooks/path-fence.sh` and `chmod
+x`. The script reads `HERMES_WRITE_SAFE_ROOT` so it tracks the launcher's
configured root automatically; if the env var is unset the hook fails open
(no-op) and the launcher is expected to be the authority.

```bash
#!/usr/bin/env bash
# Allowlist-style command fence for a single-identity Hermes profile.
# Wired in via pre_tool_call shell hook (matcher: "terminal") in config.yaml.
#
# Policy: terminal commands may only reference paths under
# HERMES_WRITE_SAFE_ROOT. System paths under /usr, /opt, /tmp, /var, /private,
# /bin, /sbin, /Library, /etc, /System, /Applications, /dev, /proc pass
# through, as do commands with no path references. Any other absolute or
# ~-prefixed path is blocked.
#
# Heuristic, not a hard sandbox: string-scans the command and won't defeat
# deliberate obfuscation (base64 decode, env indirection, alias chains). Pair
# with HERMES_WRITE_SAFE_ROOT at the file-tool layer and the swarm
# identity:<work|personal> label for defense in depth.
set -u

SAFE_ROOT="${HERMES_WRITE_SAFE_ROOT:-}"
if [[ -z "$SAFE_ROOT" ]]; then
  # Fail open: launcher is expected to set the fence. Without it the hook
  # has no policy to enforce.
  printf '{}\n'
  exit 0
fi

HOME_DIR="$HOME"
if [[ "$SAFE_ROOT" == "$HOME_DIR/"* ]]; then
  SAFE_ROOT_TILDE="~/${SAFE_ROOT#$HOME_DIR/}"
elif [[ "$SAFE_ROOT" == "$HOME_DIR" ]]; then
  SAFE_ROOT_TILDE="~"
else
  SAFE_ROOT_TILDE=""
fi

payload="$(cat -)"
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')

if [[ -z "$cmd" ]]; then
  printf '{}\n'
  exit 0
fi

emit_block() {
  jq --null-input \
    --arg p "$1" \
    --arg root "$SAFE_ROOT" \
    '{action:"block", message:("Hermes is fenced to " + $root + " — command references off-root path: " + $p + ". Relaunch under the other-identity launcher if this is cross-identity work, or move the resource under " + $root + ".")}'
  exit 0
}

is_allowed() {
  local p="$1"
  case "$p" in
    /usr|/usr/*|/opt|/opt/*|/tmp|/tmp/*|/var|/var/*|/private|/private/*|/bin|/bin/*|/sbin|/sbin/*|/Library|/Library/*|/etc|/etc/*|/System|/System/*|/Applications|/Applications/*|/dev|/dev/*|/proc|/proc/*)
      return 0 ;;
  esac
  if [[ "$p" == "$SAFE_ROOT" || "$p" == "$SAFE_ROOT/"* ]]; then
    return 0
  fi
  if [[ -n "$SAFE_ROOT_TILDE" ]] && { [[ "$p" == "$SAFE_ROOT_TILDE" ]] || [[ "$p" == "$SAFE_ROOT_TILDE/"* ]]; }; then
    return 0
  fi
  return 1
}

# Strip URLs so we don't false-positive on http://example.com/path style.
cmd_clean=$(printf '%s' "$cmd" | sed -E 's#[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]"'"'"'<>|\&\;\`\)]*##g')

while IFS= read -r tok; do
  [[ -z "$tok" ]] && continue
  tok="${tok%%[\"\'\`\)\>\<\|]}"
  while [[ "$tok" == */ || "$tok" == *. ]] && [[ "$tok" != "/" && "$tok" != "~/" ]]; do
    tok="${tok%?}"
  done
  [[ -z "$tok" ]] && continue

  if ! is_allowed "$tok"; then
    emit_block "$tok"
  fi
done < <(printf '%s' "$cmd_clean" | grep -oE '~?/[A-Za-z0-9_./~+-]+' | sort -u)

printf '{}\n'
```

### 3. Wire the hook

In `~/.hermes/profiles/personal/config.yaml`:

```yaml
hooks:
  pre_tool_call:
    - matcher: "terminal"
      command: /Users/you/.hermes/profiles/personal/agent-hooks/path-fence.sh
      timeout: 5
```

### 4. Verify

Drive the hook directly from a shell to confirm the policy:

```sh
# Allowed: under safe root
echo '{"tool_input":{"command":"cat ~/personal-repos/foo.md"}}' \
  | HERMES_WRITE_SAFE_ROOT=$HOME/personal-repos \
    ~/.hermes/profiles/personal/agent-hooks/path-fence.sh
# -> {}

# Blocked: off-root personal path
echo '{"tool_input":{"command":"cat ~/Downloads/foo"}}' \
  | HERMES_WRITE_SAFE_ROOT=$HOME/personal-repos \
    ~/.hermes/profiles/personal/agent-hooks/path-fence.sh
# -> {"action":"block","message":"Hermes is fenced to ..."}
```

Start a fresh personal Hermes session afterward so the new launcher env
reaches the process.

## Known limits

- **Heuristic, not sandbox.** Base64 decode loops, alias chains, env-var
  indirection, and `eval` paths will not be matched. If that matters,
  containerize and mount only `<SAFE_ROOT>`.
- **Persistent shell drift.** With `persistent_shell: true`, `cd ~` in one
  command then a bare `cat foo` in the next can land outside the safe root
  because the second command has no path token to scan. The file-tool layer
  still blocks writes; reads of bare files in a drifted cwd are not caught.
- **URLs.** The hook strips `proto://...` substrings before scanning so
  `curl https://api.example.com/v1/things` does not false-positive on the URL
  path.
- **System paths.** `/usr`, `/opt`, `/tmp`, `/var`, `/private`, `/bin`,
  `/sbin`, `/Library`, `/etc`, `/System`, `/Applications`, `/dev`, `/proc`
  pass through. Adjust if your safe-root model differs (for example, if you
  treat `/tmp` as sensitive shared state).

## Mirror setup for the other identity

The hook is identity-agnostic — it honors whatever `HERMES_WRITE_SAFE_ROOT` is
set in the launching environment. To fence the work side too, mirror the
pattern in the work launcher (`hermesw`) and the work profile: set
`HERMES_WRITE_SAFE_ROOT=$HOME/company-repos`, drop a copy of the hook into the
work profile's `agent-hooks/`, and wire it the same way. The two profiles
then enforce reciprocal fences against each other's roots.

## Adapting to other runtimes

The same three-layer pattern applies to Claude Code, Codex, OpenCode, etc.,
but the runtime-specific bits change:

- **File-tool layer.** Each runtime has its own write-fence mechanism (or
  doesn't). Claude Code uses `.claude/settings.json` permission rules; Codex
  exposes a sandbox config; OpenCode has its own permission model. Check the
  runtime's docs.
- **Terminal layer.** Each runtime ships its own hook protocol with different
  matcher syntax and JSON payload shape. Adapt the `jq -r '.tool_input.command'`
  extractor accordingly.

The identity label, separate `SWARM_DB_PATH`, and launcher/config-root
boundary apply identically — those are coordination-layer concerns that
swarm-mcp owns and don't change per runtime.
