export function assertCodexSmokeOptIn(env = process.env) {
  if (env.HYO_CODEX_SMOKE !== "1") {
    throw new Error(
      "Set HYO_CODEX_SMOKE=1 only when you intend to spend account quota and have supplied a safe smoke fixture.",
    );
  }
}

export function createJsonlDecoder(onMessage) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += Buffer.from(chunk).toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            throw new Error(
              `Codex app-server emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            throw new Error("Codex app-server emitted invalid JSONL: expected an object");
          }
          onMessage(message);
        }
        newline = buffer.indexOf("\n");
      }
    },
  };
}

export function buildSmokeProtocol({ cwd, fixture }) {
  const prompt = [
    "Perform exactly one bounded read-only subagent action.",
    `Spawn exactly one subagent and ask it to read only ${JSON.stringify(fixture)} in the current working directory,`,
    "report the first non-empty line, then wait for it to reach a terminal state and close it if the stable collaboration tools make close available.",
    "Do not edit files, run shell commands, use network access, or inspect any other path; this action must remain read-only.",
  ].join(" ");
  return {
    initialize: {
      method: "initialize",
      params: {
        clientInfo: {
          name: "hyo-codex-smoke",
          title: "Hyo Codex smoke",
          version: "0.4.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
    },
    initialized: { method: "initialized" },
    threadStart: {
      method: "thread/start",
      params: {
        cwd,
        approvalPolicy: "on-request",
        sandbox: "read-only",
        ephemeral: true,
      },
    },
    turnStart: {
      method: "turn/start",
      params: {
        threadId: "",
        input: [{ type: "text", text: prompt, text_elements: [] }],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      },
    },
  };
}

export function observeCollabSmokeMessage(state, message) {
  for (const item of extractItems(message)) {
    if (item.type !== "collabAgentToolCall" && item.type !== "collabToolCall") {
      continue;
    }
    const tool = normalizeWireName(item.tool);
    const status = normalizeWireName(item.status);
    if (tool === "spawn_agent") state.sawSpawn = true;
    if (status === "failed") state.failed = true;
    if (
      status === "completed" &&
      (tool === "wait" || tool === "close_agent")
    ) state.sawCompletedWaitOrClose = true;
    const agentStatuses = [
      ...Object.values(item.agentsStates ?? {}).map((agent) => agent?.status),
      stableAgentStatus(item.agentStatus),
    ];
    if (agentStatuses.some((agentStatus) =>
      TERMINAL_AGENT_STATUSES.has(normalizeWireName(agentStatus)))) {
      state.sawTerminalAgent = true;
    }
  }
  return state;
}

export function assertCollabSmokeEvidence(state) {
  if (state.failed) {
    throw new Error("Codex collaboration tool call reported failure.");
  }
  if (!state.sawSpawn) {
    throw new Error(
      "Codex smoke did not receive a collabAgentToolCall/collabToolCall spawn event.",
    );
  }
  if (!state.sawCompletedWaitOrClose && !state.sawTerminalAgent) {
    throw new Error(
      "Codex smoke received a spawn but no completed wait/close operation or terminal agent status.",
    );
  }
}

const TERMINAL_AGENT_STATUSES = new Set([
  "completed",
  "interrupted",
  "errored",
  "failed",
  "shutdown",
  "not_found",
]);

function stableAgentStatus(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return typeof value.status === "string"
    ? value.status
    : typeof value.type === "string"
      ? value.type
      : undefined;
}

function normalizeWireName(value) {
  return typeof value === "string"
    ? value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    : "";
}

function extractItems(message) {
  const item = message?.params?.item;
  const turnItems = message?.params?.turn?.items;
  return [
    ...(item && typeof item === "object" ? [item] : []),
    ...(Array.isArray(turnItems) ? turnItems : []),
  ];
}
