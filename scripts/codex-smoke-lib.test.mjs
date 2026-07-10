import { describe, expect, it } from "vitest";
import {
  assertCodexSmokeOptIn,
  assertCollabSmokeEvidence,
  buildSmokeProtocol,
  createJsonlDecoder,
  observeCollabSmokeMessage,
} from "./codex-smoke-lib.mjs";

describe("Codex smoke opt-in", () => {
  it("refuses to run unless the quota-spending flag is exactly enabled", () => {
    expect(() => assertCodexSmokeOptIn({})).toThrow(
      /HYO_CODEX_SMOKE=1.*account quota/i,
    );
    expect(() => assertCodexSmokeOptIn({ HYO_CODEX_SMOKE: "yes" })).toThrow(
      /HYO_CODEX_SMOKE=1/,
    );
    expect(() => assertCodexSmokeOptIn({ HYO_CODEX_SMOKE: "1" })).not.toThrow();
  });
});

describe("Codex smoke JSONL framing", () => {
  it("reassembles split JSONL chunks and rejects malformed protocol output", () => {
    const messages = [];
    const decoder = createJsonlDecoder((message) => messages.push(message));

    decoder.push('{"id":1,"res');
    decoder.push('ult":{}}\r\n\n{"method":"item/started","params":{}}\n');

    expect(messages).toEqual([
      { id: 1, result: {} },
      { method: "item/started", params: {} },
    ]);
    expect(() => decoder.push("not-json\n")).toThrow(/invalid JSONL/i);
  });
});

describe("Codex collab smoke evidence", () => {
  it("does not treat a completed spawn with a running child as terminal", () => {
    const state = {};
    observeCollabSmokeMessage(state, {
      method: "item/completed",
      params: {
        item: {
          type: "collabToolCall",
          tool: "spawn_agent",
          status: "completed",
          newThreadId: "child",
          agentStatus: { status: "running" },
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).toThrow(/terminal/i);
  });

  it.each(["wait", "close_agent"])(
    "does not treat an in-progress %s operation as terminal",
    (tool) => {
      const state = {};
      observeCollabSmokeMessage(state, {
        method: "item/started",
        params: {
          item: {
            type: "collabToolCall",
            tool: "spawn_agent",
            status: "inProgress",
            newThreadId: "child",
            agentStatus: "running",
          },
        },
      });
      observeCollabSmokeMessage(state, {
        method: "item/started",
        params: {
          item: {
            type: "collabToolCall",
            tool,
            status: "inProgress",
            receiverThreadId: "child",
            agentStatus: "running",
          },
        },
      });

      expect(() => assertCollabSmokeEvidence(state)).toThrow(/terminal/i);
    },
  );

  it("accepts distinct current stable spawn and completed wait events", () => {
    const state = {};
    observeCollabSmokeMessage(state, {
      method: "item/started",
      params: {
        item: {
          type: "collabToolCall",
          tool: "spawn_agent",
          status: "inProgress",
          newThreadId: "child",
          agentStatus: "running",
        },
      },
    });

    observeCollabSmokeMessage(state, {
      method: "item/completed",
      params: {
        item: {
          type: "collabToolCall",
          tool: "wait",
          status: "completed",
          receiverThreadId: "child",
          agentStatus: "completed",
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).not.toThrow();
  });

  it("accepts actual terminal agent status from a current stable spawn item", () => {
    const state = {};
    observeCollabSmokeMessage(state, {
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          items: [
            {
              type: "collabToolCall",
              tool: "spawn_agent",
              status: "completed",
              newThreadId: "child",
              agentStatus: { type: "shutdown", message: "closed" },
            },
          ],
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).not.toThrow();
  });

  it("keeps legacy collaboration evidence support", () => {
    const state = {};
    observeCollabSmokeMessage(state, {
      method: "item/started",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          agentsStates: { child: { status: "running" } },
        },
      },
    });
    observeCollabSmokeMessage(state, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "closeAgent",
          status: "completed",
          agentsStates: { child: { status: "shutdown" } },
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).not.toThrow();
  });

  it("fails when any collaboration call reports failure", () => {
    const state = {};
    for (const item of [
      { type: "collabToolCall", tool: "spawn_agent", status: "completed", agentStatus: "running" },
      { type: "collabToolCall", tool: "wait", status: "failed", agentStatus: "completed" },
    ]) {
      observeCollabSmokeMessage(state, {
        method: "item/completed",
        params: { item },
      });
    }

    expect(() => assertCollabSmokeEvidence(state)).toThrow(/failure/i);
  });
});

describe("Codex smoke protocol", () => {
  it("uses stable APIs with read-only sandbox, conservative approvals, and no network", () => {
    const protocol = buildSmokeProtocol({ cwd: "/safe/fixture", fixture: "note.md" });

    expect(protocol.initialize.params.capabilities).toEqual({
      experimentalApi: false,
      requestAttestation: false,
    });
    expect(protocol.threadStart).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/safe/fixture",
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ephemeral: true,
      },
    });
    expect(protocol.turnStart.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(protocol.turnStart.params.input[0].text).toMatch(
      /exactly one.*subagent.*note\.md.*read-only/i,
    );
  });
});
