# Session and task ownership verification

Windows; Bun 1.3.11 and Node 22.14.0. Isolated temporary databases only.

The full run before the last IPC test: **235 passed, 38 failed, 781 assertions**.
The failed-test names exactly match the retained inbox baseline. The final IPC
delta separately passed **8 tests, 17 assertions**. TypeScript checking passed.
See [full suite output](full-suite.log) and [IPC delta output](ipc-suite.log).

Identity tests exercise restart adoption with retained inbox data, revoked old
capabilities, lost enrollment response replay, wrong resume-secret rejection,
project/profile and label isolation, real-path root validation, independent
transport/runtime/progress timestamps, and suspension/resume. They inspect stored
agent/session/command/event rows to verify neither plaintext credential persists.

Task tests exercise expired and superseded attempts, stale completion/renewal,
repeat recovery, suspended owners, long tools with lease renewal but no model
progress, cancellation during work, dependency propagation, failed-result retention
through retry, and scope isolation. For **each of Bun and Node**, eight independent
processes compete for one task: one claim succeeds, seven return conflict, and
exactly one attempt exists. Prior abandoned attempts and their reasons remain.

The additional IPC test enrolls a real session in a Node owner, creates and claims
a task from a Bun client, reads attempt history, suspends the session, and observes
`stale_session` on the late completion request over the same connection.

Rerun with `bun test test/coordination-sessions.test.ts
test/coordination-tasks.test.ts test/coordination-ipc.test.ts`; run `bunx tsc --noEmit`
for type checking. [Contract and integration boundary](../../session-and-task-ownership.md).
