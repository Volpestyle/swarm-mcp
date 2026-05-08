# May 1st Plan Archive And Authority Map

This file prevents old overhaul plans from accidentally becoming the active execution path again.

## Archive Closeout

Closed on 2026-05-02: the pre-May-1 overhaul phase sequence is archived. The old Phase 4/5/6/7 plans are not active backlog. Use them only as historical evidence, implementation references, manual-QA checklists, or reusable source material for the May 1st MVP path.

Reopening any archived phase requires an explicit Mathew instruction naming the phase or scope to reopen.

## Current Authority

Active product authority:

- `docs/MAY_1ST_OVERHAUL_PLAN.md`
- `docs/MAY_1ST_EXECUTION_BOOTSTRAP.md`
- `docs/OVERHAUL_EXECUTION_STATUS.md`
- `docs/OVERHAUL_HANDOFF_PROMPT.md`

Use the old phase plans as historical evidence and source material only. Do not resume them as linear execution unless Mathew explicitly reopens one.

The May 2 UX correction is folded into the May 1st authority docs. It is not a new execution lane. Treat it as the rule that the MVP happy path is project-first: directory, scope/channel, command, launch profile, and PTY/process truth belong in Advanced or Debug unless an incongruency needs review.

## Archive Rule

Do not physically move the old phase files yet. They are still linked by status docs, manual QA docs, and prior handoff material. Treat them as archived by authority status instead:

- **Complete:** implemented and closed for the old phase model.
- **Implemented, QA pending:** code exists, but human-visible proof is incomplete.
- **Historical/gated:** superseded by the May 1st plan unless explicitly reopened.
- **Reference only:** useful for patterns, commands, or tests, not a current task list.

## Previous Phase Status

| Plan | Status | How To Use Now |
| --- | --- | --- |
| `docs/superpowers/plans/2026-04-22-phase-0-lab-baseline-and-team-execution.md` | Complete | Reference for baseline setup and swarm execution conventions. |
| `docs/superpowers/plans/2026-04-22-phase-1-launch-productization.md` | Complete | Reference for launch/profile implementation details. Do not reopen unless launch regression appears. |
| `docs/superpowers/plans/2026-04-22-phase-2-acceleration-tooling.md` | Complete | Reference for CLI/UI acceleration commands and export/screenshot contracts. |
| `docs/manual-qa/listener-health-reliability-sync.md` | Complete baseline | Preserve listener-health proof. Use for regressions and Stage 2 status proof. |
| `docs/superpowers/plans/2026-04-22-phase-3-agent-identity-overhaul.md` | Complete and closed | Preserve terminal-first node baseline, Agent Deck, launch/profile ownership, and role/emoji customization. |
| `docs/superpowers/plans/2026-04-22-phase-4-project-spaces.md` | Archived; implemented, QA pending | Mine for Project Cockpit data/types. Do not force the boundary-first UX into the May 1st flow. |
| `docs/manual-qa/phase-4-project-spaces.md` | Archived QA reference | Use only for focused smoke checks of existing project behavior before reusing it. |
| `docs/superpowers/plans/2026-04-22-phase-5-assets-and-multimodal-context.md` | Archived; implemented, QA pending | Mine for Viewer/context/asset implementation. Do not continue as the main execution lane. |
| `docs/manual-qa/phase-5-assets-and-multimodal-context.md` | Archived QA reference | Use to smoke existing asset and viewer-adjacent behavior before Stage 4/10 work. |
| `docs/superpowers/plans/2026-04-22-phase-6-startup-branding-and-credit.md` | Archived historical/source material | Do not continue visual branding as a standalone priority. Pull useful Home work into Stage 1 only. |
| `docs/manual-qa/phase-6-startup-branding-and-credit.md` | Archived QA reference | Use only if Stage 1 touches the same Home surfaces. |
| `docs/superpowers/plans/2026-04-22-phase-7-themes-and-protocol-views.md` | Archived/gated | Defer. Pull protocol-view ideas only after the task-board loop works. |
| `docs/manual-qa/phase-7-themes-and-protocol-views.md` | Archived QA reference | Reference only. |

## Product Debt To Close Before Broad New Work

1. Run a short installed-app smoke for the existing Home, Project, Launch, Terminal, and Asset surfaces.
2. Record which old Phase 4/5/6 behavior is usable in the May 1st MVP.
3. Do not build the full Viewer, Majordomo, background agents, or left rail until the MVP task-board loop proves useful.

## May 1st MVP Slice

The first implementation slice is not all of the May 1st plan.

Build only:

1. Home simplified around `Open Project`, `Start From Plan`, and `Resume Running Agents`.
2. Project Cockpit as the default project landing surface.
3. Task Board inside Project Cockpit.
4. Multi-select task rows.
5. Assignment sheet with provider/role per selected row.
6. Launch selected tasks into task-bound agents for one reliable provider path first.
7. Basic status proof: listener state, task state, elapsed time, last activity, done/failed.

Everything else is follow-up unless it is required to make this loop safe. In particular, do not let Advanced Launch, scope/channel pickers, saved-agent internals, or process diagnostics become the first-run user model.
