# Herdr swarm metadata two-agent test review

This captures the review of a two-agent `swarm-mcp` test where a planner and an implementer coordinated the Herdr task `628337b9-728d-491d-b270-55986aa08bcd`: add swarm metadata to the Herdr bottom-left agents list and provide a right-click copy action for the swarm instance ID.

## Verdict

The run was successful as a real coordination test, not just a happy-path demo. The agents produced a real patch, validation passed, and the planner caught an implementation gap while the worker was still active.

The strongest signal was the mid-flight review loop: the worker had added the metadata reader and UI plumbing, but the metadata lookup was not wired into app state. The planner noticed this from the partial diff, sent a targeted note, and the worker corrected it with a bounded runtime refresh instead of doing database work from render paths.

## What worked

- The task completed with a concrete implementation rather than only analysis.
- The worker used an isolated worktree because the target Herdr checkout already had unrelated dirty changes.
- The planner monitored progress, inspected partial diffs, and gave a focused corrective note before the worker finished.
- The finished patch was applied back to the main Herdr checkout without overwriting unrelated local changes.
- The worker reported structured task results, changed files, and validation status.
- Focused tests, full `cargo test`, format checks, and Python maintenance tests were run.
- The worker released locks and deregistered after completion.

## Rough edges

- Task claiming and status updates were not smooth at first. The planner had to nudge the worker because the bridge path did not clearly expose or use claim/update behavior.
- The transcript was noisy. Auto-review approvals, pane reads, wait calls, and repeated status checks made the useful coordination story harder to read.
- The worker environment was missing `just` and `cargo-nextest`, so validation had to fall back to direct `cargo` commands.
- Workspace identity publishing was inconsistent. The planner saw a Herdr identity row for the worker, but the worker pane apparently did not publish identity because a Codex hook was gated. New code should publish `identity/workspace/herdr/<instance_id>` and treat `identity/herdr/<instance_id>` only as a compatibility row.
- Stale or unrelated swarm traffic appeared in the same scope and briefly distracted the planner.
- The coordination scope was `/Users/james.volpe/volpestyle/swarm-mcp`, while the implementation target was `/Users/james.volpe/herdr`. That may be intentional for this test, but it weakens the intuition that file locks map cleanly to the repo being edited.

## Follow-ups

- Make task claim/update available and obvious in the worker path so the planner does not need to supervise basic state transitions.
- Reduce transcript noise for routine coordination actions, especially approval wrappers around read-only polling and pane inspection.
- Ensure Codex and Claude Herdr identity publication is reliable across spawned panes.
- Preflight worker tool availability for project validation commands such as `just` and `cargo-nextest`.
- Consider making target-repo scope and file-root behavior more explicit when a swarm task coordinates work outside the swarm-mcp checkout.
- Keep the successful pattern: planner monitors partial work, sends focused review notes, and the worker adapts before final validation.
