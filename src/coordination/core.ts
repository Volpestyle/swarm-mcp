import { randomUUID } from "node:crypto";
import { CoordinationError, requireText } from "./errors";
import { CoordinationStore, type CommandResult, type Json } from "./store";
import type { InboxCommand } from "./inbox";

// Trusted application context. The local service supplies this after validating
// its session capability; transports must never treat a caller's label as auth.
export interface ActorContext {
  scope: string;
  actor: string;
}
export type CoreCommand =
  | InboxCommand
  | { id: string; type: "task.create"; payload: { title: string } }
  | {
      id: string;
      type: "task.cancel";
      payload: { taskId: string; expectedVersion: number };
    };

export class CoordinationCore {
  constructor(private readonly store: CoordinationStore) {}

  command(context: ActorContext, command: CoreCommand): CommandResult<Json> {
    return this.store.execute({ ...command, ...context }, (tx) => {
      switch (command.type) {
        case "message.send":
          return tx.inbox.send(
            command.payload,
            [command.payload.recipient],
            "direct",
          );
        case "message.announce":
          return tx.inbox.send(
            command.payload,
            command.payload.recipients,
            "announcement",
          );
        case "inbox.fetch":
          return tx.inbox.fetch(command.payload);
        case "inbox.ack":
          return tx.inbox.acknowledge(command.payload);
        case "inbox.reject":
          return tx.inbox.reject(command.payload);
        case "inbox.sweep":
          return tx.inbox.sweep();
        case "task.create": {
          requireText(command.payload.title, "title", 1024);
          const task = {
            id: randomUUID(),
            scope: context.scope,
            creator: context.actor,
            title: command.payload.title,
            status: "open" as const,
            version: 1,
            created_at: tx.at,
            updated_at: tx.at,
          };
          tx.createTask(task);
          tx.event("task.created", task.id, {
            title: task.title,
            version: task.version,
          });
          return { task };
        }
        case "task.cancel": {
          const { taskId, expectedVersion } = command.payload;
          requireText(taskId, "taskId");
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
            throw new CoordinationError(
              "invalid_input",
              "expectedVersion must be a positive integer",
            );
          const task = tx.task(taskId);
          if (!task)
            throw new CoordinationError(
              "not_found",
              "Task does not exist in this scope",
            );
          if (task.creator !== context.actor)
            throw new CoordinationError(
              "forbidden",
              "Only the task creator may cancel unclaimed work",
            );
          tx.cancelTask(taskId, expectedVersion);
          tx.event("task.cancelled", taskId, { version: expectedVersion + 1 });
          return {
            task: {
              ...task,
              status: "cancelled",
              version: expectedVersion + 1,
              updated_at: tx.at,
            },
          };
        }
        default:
          throw new CoordinationError(
            "unknown_command",
            "Unknown coordination command",
          );
      }
    });
  }

  task(context: ActorContext, id: string) {
    return this.store.task(context.scope, id);
  }
  inbox(context: ActorContext, cursor = 0, limit = 50) {
    return this.store.inbox(context.scope, context.actor, cursor, limit);
  }
  messageStatus(context: ActorContext, id: string) {
    return this.store.messageStatus(context.scope, context.actor, id);
  }
  events(context: ActorContext, cursor = 0, limit = 100) {
    return this.store.events(context.scope, cursor, limit);
  }

  waitForEvents(
    context: ActorContext,
    cursor: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
      throw new CoordinationError(
        "invalid_input",
        "Wait must be between 1 and 30000 milliseconds",
      );
    this.events(context, cursor); // Validate before installing any listener.
    return new Promise<ReturnType<CoordinationCore["events"]>>(
      (resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe = () => {};
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else {
            try {
              resolve(this.events(context, cursor));
            } catch (failure) {
              reject(failure);
            }
          }
        };
        const abort = () =>
          finish(new CoordinationError("aborted", "Event wait cancelled"));
        unsubscribe = this.store.subscribe(() => {
          try {
            if (this.events(context, cursor).items.length) finish();
          } catch (error) {
            finish(error as Error);
          }
        });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => finish(), timeoutMs);
        if (signal?.aborted) abort();
        else if (this.events(context, cursor).items.length) finish();
      },
    );
  }
}
