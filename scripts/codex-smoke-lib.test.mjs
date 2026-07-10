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
  it("accepts the current collab alias only after spawn and terminal evidence", () => {
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
    expect(() => assertCollabSmokeEvidence(state)).toThrow(/terminal/i);

    observeCollabSmokeMessage(state, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          agentsStates: { child: { status: "completed" } },
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).not.toThrow();
  });

  it("accepts the documented collabToolCall alias in terminal turn items", () => {
    const state = {};
    observeCollabSmokeMessage(state, {
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          items: [
            { type: "collabToolCall", tool: "spawn_agent", status: "completed" },
          ],
        },
      },
    });

    expect(() => assertCollabSmokeEvidence(state)).not.toThrow();
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
