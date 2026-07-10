import * as fs from "fs";
import * as path from "path";
import { ClaudeTransport, normalizeModelId } from "../../claude-transport";
import {
  getProjectDir,
  listPastSessions,
  loadSessionHistory,
  saveCustomTitle,
} from "../../session-parser";
import {
  isThinkingBlockApiError,
  repairSession,
} from "../../session-repair";
import { generateConversationTitle } from "../../title-generator";
import type {
  ChatProvider,
  ProviderCapabilities,
  ProviderRuntime,
  ProviderRuntimeOptions,
} from "../types";
import { ClaudeEventNormalizer } from "./event-normalizer";

const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  approvals: true,
  questions: true,
  planReview: true,
  agents: true,
  sessionHistory: true,
  sessionRename: true,
  compaction: true,
  recovery: true,
  tokenUsage: true,
};

function readPlanFile(cwd: string): string | null {
  try {
    const candidates = [
      path.join(cwd, ".claude", "plan.md"),
      path.join(cwd, "plan.md"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8");
    }
  } catch {
    // The normalizer will surface a plan review with null content.
  }
  return null;
}

class ClaudeRuntime implements ProviderRuntime {
  readonly providerId = "claude" as const;
  ready = false;
  private readonly transport: ClaudeTransport;

  constructor(cliPath: string, options: ProviderRuntimeOptions) {
    const normalizer = new ClaudeEventNormalizer(() => readPlanFile(options.cwd));
    const emit = (events: ReturnType<ClaudeEventNormalizer["normalize"]>) => {
      for (const event of events) {
        if (event.type === "session_metadata") this.ready = true;
        if (event.type === "closed") this.ready = false;
        options.onEvent(event);
      }
    };

    this.transport = new ClaudeTransport({
      cliPath,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      agent: options.agent,
      sessionId: options.providerSessionId,
      resume: options.resume,
      maxOutputTokens: options.maxOutputTokens,
      onMessage: (raw) => emit(normalizer.normalize(raw)),
      onError: (error) => emit(normalizer.normalizeError(error)),
      onClose: (code) => emit(normalizer.normalizeClose(code)),
    });
  }

  start(): void {
    this.transport.spawn();
  }

  isRunning(): boolean {
    return this.transport.isRunning();
  }

  send(content: string | any[]): void {
    this.transport.sendUserMessage(content);
  }

  interrupt(): void {
    this.transport.sendInterrupt();
  }

  respondApproval(
    requestId: string,
    behavior: "allow" | "allow_always" | "deny",
    toolName?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.transport.sendPermissionResponse(
      requestId,
      behavior,
      toolName,
      updatedInput,
    );
  }

  respondQuestion(
    requestId: string,
    questions: Parameters<ProviderRuntime["respondQuestion"]>[1],
    answers: Record<string, string>,
  ): void {
    this.respondApproval(requestId, "allow", undefined, { questions, answers });
  }

  compact(): void {
    this.send("/compact");
  }

  cleanup(): void {
    this.transport.stop();
  }
}

export function createClaudeProvider(options: { cliPath: string }): ChatProvider {
  const runtimes = new Set<ProviderRuntime>();

  return {
    id: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    createRuntime(runtimeOptions) {
      const runtime = new ClaudeRuntime(options.cliPath, runtimeOptions);
      runtimes.add(runtime);
      return runtime;
    },
    listSessions(cwd) {
      return listPastSessions(cwd).map((session) => ({
        providerId: "claude" as const,
        ...session,
      }));
    },
    loadSession(cwd, sessionId) {
      return loadSessionHistory(cwd, sessionId);
    },
    renameSession(cwd, sessionId, title) {
      saveCustomTitle(cwd, sessionId, title);
    },
    recoverSession(cwd, sessionId) {
      const jsonlPath = path.join(getProjectDir(cwd), `${sessionId}.jsonl`);
      return repairSession(jsonlPath);
    },
    generateTitle(input) {
      return generateConversationTitle({
        cliPath: options.cliPath,
        ...input,
      });
    },
    normalizeModelId,
    cleanup() {
      for (const runtime of runtimes) runtime.cleanup();
      runtimes.clear();
    },
    isRecoverableError: isThinkingBlockApiError,
  };
}
