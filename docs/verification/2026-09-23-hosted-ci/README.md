# Hosted CI: first runs after unarchive

`Volpestyle/swarm-mcp` was unarchived and `redesign/coordination-core` pushed on
2026-09-23 (draft PR [#9](https://github.com/Volpestyle/swarm-mcp/pull/9)).
The workflow in `.github/workflows/coordination.yml` runs `verify-coordination.ts`
and `verify:package` on `ubuntu-latest` and `windows-latest`.

## Passing run

[Run 35834256999](https://github.com/Volpestyle/swarm-mcp/actions/runs/35834256999)
on the pull request merge ref of `0ab6b90` (manifest revision `40cc584`):
175 TypeScript tests / 48 files and 48 Python tests pass on both runners with
`sourceChanged: false`; `verify:package` passes. Retained:
[ubuntu-manifest.json](ubuntu-manifest.json), [windows-manifest.json](windows-manifest.json).
Full logs stay attached to the run as `coordination-<os>` artifacts.

## What the earlier runs exposed

| Run | Result | Cause | Fix |
| --- | --- | --- | --- |
| [35826481932](https://github.com/Volpestyle/swarm-mcp/actions/runs/35826481932) (`f3b724c`) | Ubuntu green; Windows 13 failures + source guard | `Get-Acl` could not autoload under the PSModulePath inherited from a pwsh 7 step; `realpathSync` keeps 8.3 short names (`RUNNER~1` temp dir) so worktree paths looked outside their root; the build's LF rewrite of `src/generated/protocol.ts` read as a modification under `core.autocrlf=true` | `d084ae7`: cmdlet-free .NET ACL script; `realpathSync.native` in `worktrees`, `sessions`, `codex-launcher` plus a short-name regression test; `.gitattributes` pins generated TypeScript to LF |
| [35830279777](https://github.com/Volpestyle/swarm-mcp/actions/runs/35830279777) (`d084ae7`) | Ubuntu green; Windows 10 failures | Elevated administrator token owns created objects as `S-1-5-32-544`, so the strict user-SID owner check rejected launcher state | `9dc8ab4`: accept the user SID or the token default owner (`WindowsIdentity.Owner`); report both SIDs on mismatch |
| [35831231855](https://github.com/Volpestyle/swarm-mcp/actions/runs/35831231855) (`9dc8ab4`, push) | Both green | First fully passing hosted run | |
| [35831235965](https://github.com/Volpestyle/swarm-mcp/actions/runs/35831235965) (`9dc8ab4`, PR) | Ubuntu green; Windows 1 timeout | `lost-response reconciles …` stalled 5.2s at bun's 5s default; 250ms in every other run | `75dc1a7`: explicit 20s timeout |
| [35832200868](https://github.com/Volpestyle/swarm-mcp/actions/runs/35832200868) (`75dc1a7`, push) | Ubuntu 1 failure; Windows 8 timeouts | Ubuntu: one of four simultaneous launchers rejected in 437ms, reason not visible. Windows: suite took 206s (115s when green) and eight real-process tests exceeded 5s | `0ab6b90`: launcher keeps connecting after its own candidate exits; owner test reports rejection reasons; gate runs `bun test --timeout 30000`; push runs limited to `main` |
| [35832204663](https://github.com/Volpestyle/swarm-mcp/actions/runs/35832204663) (`75dc1a7`, PR) | Both green | Same commit as the row above; runner variance | |

The Ubuntu launcher rejection has not recurred and its cause is not
confirmed; the owner test now prints the reason if it does. Local runs on a
loaded workstation showed the same 5s-default timeouts (PowerShell start took
3–5s under load) and an intermittent `coordination-legacy-guard` failure that
imports none of the changed code; neither is covered by this evidence.
