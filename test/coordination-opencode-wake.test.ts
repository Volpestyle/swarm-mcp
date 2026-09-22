import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpenCodeWake } from "../src/coordination/opencode-wake";

for (const persisted of [false, true]) {
  test(`uncertain wake reconciles retained intent (host persisted=${persisted}) without another POST`, async () => {
    let posts = 0;
    let found = false;
    const api = {
      session: {
        async get() {
          return { data: { time: {} } };
        },
        async status() {
          return { data: {} };
        },
        async message() {
          return found
            ? { data: { info: {} }, response: { status: 200 } }
            : { response: { status: 404 } };
        },
        async promptAsync() {
          posts++;
          found = persisted;
          throw new Error("Response lost");
        },
      },
      permission: {
        async list() {
          return { data: [] };
        },
      },
      question: {
        async list() {
          return { data: [] };
        },
      },
    } as unknown as OpencodeClient;
    const options = {
      api,
      actor: "actor",
      scope: "scope",
      hostSessionId: "ses_fixture",
      stateDirectory: join(
        mkdtempSync(join(tmpdir(), "wake-intent-")),
        "private",
      ),
      request: async () => ({
        deliveries: [{ recipient: "actor", state: "pending", attempts: 0 }],
      }),
    };
    const first = await new OpenCodeWake(options).notify("message");
    expect(first.status).toBe("uncertain");
    const recovered = await new OpenCodeWake(options).notify("message");
    expect(recovered.status).toBe(persisted ? "accepted" : "uncertain");
    expect(posts).toBe(1);
  });
}

test("each recovered delivery attempt gets one new wake, retained across adapter replacement", async () => {
  const prompts = new Set<string>();
  let posts = 0;
  let attempts = 0;
  const api = {
    session: {
      async get() {
        return { data: { time: {} } };
      },
      async status() {
        return { data: {} };
      },
      async message(input: { messageID: string }) {
        return prompts.has(input.messageID)
          ? { data: { info: {} }, response: { status: 200 } }
          : { response: { status: 404 } };
      },
      async promptAsync(input: { messageID: string }) {
        posts++;
        prompts.add(input.messageID);
      },
    },
    permission: {
      async list() {
        return { data: [] };
      },
    },
    question: {
      async list() {
        return { data: [] };
      },
    },
  } as unknown as OpencodeClient;
  const options = {
    api,
    actor: "actor",
    scope: "scope",
    hostSessionId: "session",
    stateDirectory: join(
      mkdtempSync(join(tmpdir(), "wake-attempt-")),
      "private",
    ),
    request: async () => ({
      deliveries: [{ recipient: "actor", state: "pending", attempts }],
    }),
  };
  const first = await new OpenCodeWake(options).notify("message");
  expect(first.status).toBe("accepted");
  expect(await new OpenCodeWake(options).notify("message")).toEqual(first);
  expect(posts).toBe(1);
  attempts = 1;
  const recovered = await new OpenCodeWake(options).notify("message");
  expect(recovered.status).toBe("accepted");
  expect(recovered.messageId).not.toBe(first.messageId);
  expect(await new OpenCodeWake(options).notify("message")).toEqual(recovered);
  expect(posts).toBe(2);
}, 10000);
