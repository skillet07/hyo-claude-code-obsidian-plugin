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
    const tool = item.tool;
    const status = item.status;
    if (tool === "spawnAgent" || tool === "spawn_agent") state.sawSpawn = true;
    if (status === "failed") state.failed = true;
    if (
      status === "completed" ||
      tool === "wait" ||
      tool === "closeAgent" ||
      tool === "close_agent" ||
      Object.values(item.agentsStates ?? {}).some((agent) =>
        ["completed", "interrupted", "errored", "shutdown", "notFound"].includes(
          agent?.status,
        ),
      )
    ) {
      state.sawTerminal = true;
    }
  }
  return state;
}

export function assertCollabSmokeEvidence(state) {
  if (!state.sawSpawn) {
    throw new Error(
      "Codex smoke did not receive a collabAgentToolCall/collabToolCall spawn event.",
    );
  }
  if (!state.sawTerminal) {
    throw new Error(
      "Codex smoke received a spawn but no terminal, wait, or close collaboration status.",
    );
  }
  if (state.failed) {
    throw new Error("Codex collaboration tool call reported failure.");
  }
}

function extractItems(message) {
  const item = message?.params?.item;
  const turnItems = message?.params?.turn?.items;
  return [
    ...(item && typeof item === "object" ? [item] : []),
    ...(Array.isArray(turnItems) ? turnItems : []),
  ];
}
