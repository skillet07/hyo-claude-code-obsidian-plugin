import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
} from "../chat-types";
import { ProviderRegistry } from "../providers/registry";
import { createClaudeProvider } from "../providers/claude/provider";
import type {
  ChatProvider,
  ProviderContentBlock,
  ProviderEvent,
  ProviderHistoryMessage,
  ProviderId,
  ProviderRecoveryResult,
  ProviderRuntime,
  ProviderSessionSummary,
  ProviderSessionOptions,
} from "../providers/types";
import {
  applyAgentMessageCompletion,
  applyProviderTextDelta,
} from "../providers/event-reducer";
import {
  SessionLifecycle,
  type RuntimeLease,
} from "./session-lifecycle";

// Re-export for convenience
export type PastSession = ProviderSessionSummary;

// ------- types -------

interface StreamState {
  toolCalls: ToolCallData[];
  orderedBlocks: OrderedBlock[];
  turnIndex: number;
  toolResultSinceLastText: boolean;
  skillResultPending: boolean; // true after Skill tool_result, until next text block is consumed
}

export interface TabSession {
  id: string;
  readonly providerId: ProviderId;
  readonly providerSessionId: string | null;
  readonly providerState: unknown;
  /** Immutable launch settings captured when this tab is created/opened. */
  readonly runtimeConfiguration?: {
    cwd: string;
    maxOutputTokens?: number;
  };
  title: string;
  messages: Message[];
  generating: boolean;
  model: string;
  reasoningEffort?: string;
  approvalPolicy?: ProviderSessionOptions["approvalPolicy"];
  sandboxMode?: ProviderSessionOptions["sandboxMode"];
  networkAccess?: boolean;
  permissionMode: string;
  agent: string;
  inputTokens: number;
  contextWindow?: number;
  voiceMode: boolean;
}

interface SessionState {
  tabs: TabSession[];
  activeTabId: string;
}

export interface SessionManagerOptions {
  cliPath: string;
  cwd: string;
  model: string;
  permissionMode: string;
  defaultAgent: string;
  maxOutputTokens?: number;
  settingsVersion?: number;
  autoGenerateTitles?: boolean;
  providers?: ChatProvider[];
  defaultProviderId?: ProviderId;
  providerDefaults?: Partial<Record<ProviderId, Partial<ProviderSessionOptions>>>;
}

// ------- utilities -------

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function providerDefaultsFor(
  options: SessionManagerOptions,
  providerId: ProviderId,
): ProviderSessionOptions {
  const configured = options.providerDefaults?.[providerId];
  return {
    model: configured?.model ?? (providerId === "claude" ? options.model : ""),
    reasoningEffort: configured?.reasoningEffort,
    approvalPolicy: configured?.approvalPolicy,
    sandboxMode: configured?.sandboxMode,
    networkAccess: configured?.networkAccess,
  };
}

function processContentBlocks(
  contentArr: ProviderContentBlock[],
  ss: StreamState,
  source: "user" | "assistant",
) {
  for (const block of contentArr) {
    if (block.type === "text") {
      if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0)
        ss.turnIndex++;
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "text" && b.turnIndex === ss.turnIndex
      );
      if (existing) {
        existing.content = block.text || "";
        // When Claude's assistant event updates a previously suppressed block, unsuppress it
        if (source === "assistant") existing.isSkillOutput = false;
      } else {
        // Text arriving in a user event immediately after a Skill tool_result is a system message — hide it
        const isSkillOutput = source === "user" && ss.skillResultPending;
        ss.skillResultPending = false;
        ss.orderedBlocks.push({
          type: "text",
          content: block.text || "",
          turnIndex: ss.turnIndex,
          isSkillOutput,
        });
      }
      ss.toolResultSinceLastText = false;
    } else if (block.type === "thinking") {
      const existing = ss.orderedBlocks.find(
        (b) => b.type === "thinking" && b.turnIndex === ss.turnIndex
      );
      if (existing) existing.content = block.thinking || "";
      else
        ss.orderedBlocks.push({
          type: "thinking",
          content: block.thinking || "",
          turnIndex: ss.turnIndex,
        });
    } else if (block.type === "tool_use") {
      const tool: ToolCallData = {
        id: block.id,
        name: block.name,
        input: block.input,
        result: null,
      };
      if (!ss.toolCalls.find((t) => t.id === tool.id)) {
        ss.toolCalls.push(tool);
        ss.orderedBlocks.push({
          type: "tool",
          toolId: tool.id,
          turnIndex: ss.turnIndex,
        });
        // Immediately suppress text at this turn if it's a Skill call
        if (tool.name === "Skill") {
          for (const b of ss.orderedBlocks) {
            if (b.type === "text" && b.turnIndex === ss.turnIndex) {
              b.isSkillOutput = true;
            }
          }
        }
      }
    } else if (block.type === "tool_result") {
      const tool = ss.toolCalls.find((t) => t.id === block.toolUseId);
      if (tool) {
        tool.result =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        if (tool.name === "Skill") {
          ss.skillResultPending = true;
          // Retroactively suppress text at the same turn as the Skill tool block
          const skillBlock = ss.orderedBlocks.find(
            (b) => b.type === "tool" && b.toolId === tool.id
          );
          if (skillBlock) {
            for (const b of ss.orderedBlocks) {
              if (b.type === "text" && b.turnIndex === skillBlock.turnIndex) {
                b.isSkillOutput = true;
              }
            }
          }
        }
      }
      ss.toolResultSinceLastText = true;
    }
  }
}

function buildSnapshot(ss: StreamState) {
  return {
    content: ss.orderedBlocks
      .filter((b) => b.type === "text")
      .map((b) => b.content)
      .join(""),
    thinking: ss.orderedBlocks
      .filter((b) => b.type === "thinking")
      .map((b) => b.content)
      .join(""),
    toolCalls: [...ss.toolCalls],
    orderedBlocks: [...ss.orderedBlocks.map((b) => ({ ...b }))],
  };
}

function serializeProviderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "completed";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ------- hook -------

export function useSessionManager(options: SessionManagerOptions) {
  const providers = useMemo(
    () => options.providers ?? [createClaudeProvider({ cliPath: options.cliPath })],
    [options.providers, options.cliPath],
  );
  const registry = useMemo(() => new ProviderRegistry(providers), [providers]);
  const providerMap = useMemo(
    () => new Map<ProviderId, ChatProvider>(registry.entries()),
    [registry],
  );
  const defaultProviderId = options.defaultProviderId ?? "claude";
  const [state, setState] = useState<SessionState>(() => {
    const id = genId();
    const providerDefaults = providerDefaultsFor(options, defaultProviderId);
    return {
      tabs: [
        {
          id,
          providerId: defaultProviderId,
          providerSessionId: null,
          providerState: null,
          runtimeConfiguration: {
            cwd: options.cwd,
            maxOutputTokens: options.maxOutputTokens,
          },
          title: "New conversation",
          messages: [],
          generating: false,
          ...providerDefaults,
          permissionMode: options.permissionMode,
          agent: options.defaultAgent,
          inputTokens: 0,
          voiceMode: false,
        },
      ],
      activeTabId: id,
    };
  });

  const [pastSessions, setPastSessions] = useState<ProviderSessionSummary[]>([]);
  const pastSessionsRef = useRef(pastSessions);
  pastSessionsRef.current = pastSessions;

  const lifecycleRef = useRef(new SessionLifecycle<ProviderRuntime>());
  const latestProvidersRef = useRef(providerMap);
  const publishedProvidersRef = useRef(providerMap);
  const previousProvidersRef = useRef(providerMap);
  const defaultProviderIdRef = useRef(defaultProviderId);
  defaultProviderIdRef.current = defaultProviderId;
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const visibleProviderErrorsRef = useRef<Record<string, string>>({});
  const turnGenerationRef = useRef<Record<string, number>>({});
  const retiredTabIdsRef = useRef(new Set<string>());
  const openingSessionsRef = useRef(
    new WeakMap<ChatProvider, Set<string>>(),
  );
  const historyRequestRef = useRef(0);
  const openIntentRef = useRef(0);
  const scrollRef = useRef({ nearBottom: true });
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  const effectiveProviderMap = useMemo(() => {
    const effective = new Map(providerMap);
    for (const tab of state.tabs) {
      if (effective.has(tab.providerId)) continue;
      const retained = latestProvidersRef.current.get(tab.providerId);
      if (retained) effective.set(tab.providerId, retained);
    }
    if (!effective.has(defaultProviderId)) {
      const retainedDefault = latestProvidersRef.current.get(defaultProviderId);
      if (retainedDefault) effective.set(defaultProviderId, retainedDefault);
    }
    return effective;
  }, [defaultProviderId, providerMap, state.tabs]);

  useLayoutEffect(() => {
    const previouslyPublished = publishedProvidersRef.current;
    latestProvidersRef.current = effectiveProviderMap;
    publishedProvidersRef.current = effectiveProviderMap;
    const retiredTabIds = new Set<string>();
    for (const [providerId, previousProvider] of previouslyPublished) {
      if (effectiveProviderMap.get(providerId) === previousProvider) continue;
      for (const tabId of lifecycleRef.current.detachWhere(
        (runtime) => runtime.providerId === providerId,
      )) {
        retiredTabIds.add(tabId);
        retiredTabIdsRef.current.add(tabId);
      }
    }
    if (retiredTabIds.size === 0) return;
    for (const tabId of retiredTabIds) delete streamStatesRef.current[tabId];
  }, [effectiveProviderMap]);

  const resolveProvider = useCallback((providerId: ProviderId): ChatProvider => {
    const provider = latestProvidersRef.current.get(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" is not registered`);
    return provider;
  }, []);

  // Provider replacement happens while mounted. Detach only leases owned by
  // the retired provider so other providers can keep generating concurrently.
  useEffect(() => {
    const previousProviders = previousProvidersRef.current;
    previousProvidersRef.current = effectiveProviderMap;
    const retiredTabIds = new Set(
      [...retiredTabIdsRef.current].filter(
        (tabId) => !lifecycleRef.current.getRuntime(tabId),
      ),
    );
    retiredTabIdsRef.current.clear();
    if (retiredTabIds.size > 0) {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) =>
          retiredTabIds.has(tab.id)
            ? {
                ...tab,
                generating: false,
                messages: tab.messages.map((message) =>
                  message.role === "assistant" && message.streaming
                    ? { ...message, streaming: false }
                    : message,
                ),
              }
            : tab,
        ),
      }));
    }
    for (const [providerId, previousProvider] of previousProviders) {
      if (effectiveProviderMap.get(providerId) === previousProvider) continue;
      previousProvider.cleanup();
    }
  }, [effectiveProviderMap]);

  // Unmount teardown must not enqueue React state updates.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleRef.current.detachAll();
      for (const provider of latestProvidersRef.current.values()) provider.cleanup();
    };
  }, []);

  // ------- internal helpers -------

  const updateTabLastAssistant = useCallback(
    (tabId: string, updater: (msg: Message) => Partial<Message>) => {
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const msgs = [...tab.messages];
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === "assistant") {
              msgs[i] = { ...msgs[i], ...updater(msgs[i]) };
              break;
            }
          }
          return { ...tab, messages: msgs };
        }),
      }));
    },
    []
  );

  const surfaceProviderError = useCallback((
    tabId: string,
    error: string,
    terminal: boolean,
  ) => {
    const text = `Provider error: ${error}`;
    updateTabLastAssistant(tabId, (message) => {
      const alreadyVisible =
        message.content.includes(error) ||
        (message.orderedBlocks ?? []).some(
          (block) => block.type === "text" && block.content?.includes(error),
        );
      if (alreadyVisible) return terminal ? { streaming: false } : {};
      if ((message.orderedBlocks ?? []).length > 0) {
        return {
          content: [message.content, text].filter(Boolean).join("\n\n"),
          orderedBlocks: [
            ...(message.orderedBlocks ?? []),
            { type: "text", content: text, turnIndex: Number.MAX_SAFE_INTEGER },
          ],
          ...(terminal ? { streaming: false } : {}),
        };
      }
      return {
        content: text,
        ...(terminal ? { streaming: false } : {}),
      };
    });
  }, [updateTabLastAssistant]);

  const makeProcessEvent = useCallback(
    (tabId: string, lease: RuntimeLease, provider: ChatProvider) => (event: ProviderEvent) => {
      const lifecycle = lifecycleRef.current;
      if (!lifecycle.ownsRuntime(lease)) return;

      if (event.type === "error") {
        console.error("[hyo] Provider error:", event.message);
        if (event.willRetry === undefined) return;
        visibleProviderErrorsRef.current[tabId] = event.message;
        surfaceProviderError(tabId, event.message, event.willRetry === false);
        if (event.willRetry === false) {
          lifecycle.finishTurn(tabId);
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, generating: false } : tab,
            ),
          }));
        }
        return;
      }

      if (event.type === "closed") {
        if (!lifecycle.releaseRuntime(lease)) return;
        const wasGenerating = stateRef.current.tabs.find(
          (tab) => tab.id === tabId,
        )?.generating;
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, generating: false } : tab,
          ),
        }));
        updateTabLastAssistant(tabId, () => ({ streaming: false }));
        if (event.exitCode !== 0 && event.exitCode !== null && wasGenerating) {
          const providerLabel = provider.id === "claude" ? "Claude" : "Codex";
          const errorMsg: Message = {
            role: "assistant",
            content: `_${providerLabel} provider exited unexpectedly (code ${event.exitCode}). Start a new conversation to continue._`,
            thinking: "",
            toolCalls: [],
            orderedBlocks: [],
            streaming: false,
          };
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) =>
              tab.id === tabId
                ? { ...tab, messages: [...tab.messages, errorMsg] }
                : tab,
            ),
          }));
        }
        return;
      }

      const ss = streamStatesRef.current[tabId];
      if (!ss) return;

      if (event.type === "session_metadata") {
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  providerSessionId: event.sessionId,
                  providerState: event.providerState ?? tab.providerState,
                }
              : tab,
          ),
        }));
        return;
      }

      if (event.type === "compaction_boundary") {
        const currentTab = stateRef.current.tabs.find((t) => t.id === tabId);
        const alreadyHasCompactionMarker = currentTab?.messages.some(
          (message) => message.isCompaction && message.streaming,
        );
        if (!alreadyHasCompactionMarker) {
          const markerMsg: Message = {
            role: "assistant",
            content: "compacted",
            isCompaction: true,
            streaming: false,
            toolCalls: [],
            orderedBlocks: [],
          };
          const continuationMsg: Message = {
            role: "assistant",
            content: "",
            thinking: "",
            toolCalls: [],
            orderedBlocks: [],
            streaming: true,
          };
          setState((prev) => ({
            ...prev,
            tabs: prev.tabs.map((tab) => {
              if (tab.id !== tabId) return tab;
              const messages = [...tab.messages];
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "assistant" && messages[i].streaming) {
                  messages[i] = { ...messages[i], streaming: false };
                  break;
                }
              }
              return {
                ...tab,
                messages: [...messages, markerMsg, continuationMsg],
                generating: true,
              };
            }),
          }));
          streamStatesRef.current[tabId] = {
            toolCalls: [],
            orderedBlocks: [],
            turnIndex: 0,
            toolResultSinceLastText: false,
            skillResultPending: false,
          };
          const originatingRuntime = lifecycle.getRuntime(tabId);
          const originatingTurnGeneration = turnGenerationRef.current[tabId];
          setTimeout(() => {
            const currentLifecycle = lifecycleRef.current;
            if (
              !originatingRuntime ||
              !currentLifecycle.ownsRuntime(lease) ||
              currentLifecycle.getRuntime(tabId) !== originatingRuntime ||
              turnGenerationRef.current[tabId] !== originatingTurnGeneration
            ) return;
            originatingRuntime.send(
              "Please continue where you left off before the compaction.",
            );
          }, 100);
        }
        return;
      }

      if (event.type === "approval_requested") {
        if (event.autoApprove) {
          lifecycleRef.current.getRuntime(tabId)?.respondApproval(
            event.requestId,
            "allow",
          );
        } else {
          updateTabLastAssistant(tabId, () => ({
            permissionRequest: {
              requestId: event.requestId,
              toolName: event.toolName,
              input: event.input,
            },
          }));
        }
        return;
      }

      if (event.type === "question_requested") {
        updateTabLastAssistant(tabId, () => ({
          askQuestion: {
            id: event.requestId,
            questions: event.questions,
            answers: {},
          },
        }));
        return;
      }

      if (event.type === "plan_review_requested") {
        updateTabLastAssistant(tabId, () => ({
          planReview: {
            requestId: event.requestId,
            planContent: event.planContent,
            allowedPrompts: event.allowedPrompts,
          },
        }));
        return;
      }

      if (event.type === "request_resolved") {
        updateTabLastAssistant(tabId, (message) => ({
          ...(message.permissionRequest?.requestId === event.requestId
            ? {
              permissionRequest: {
                ...message.permissionRequest,
                resolved: "denied" as const,
              },
            }
            : {}),
          ...(message.askQuestion?.id === event.requestId
            ? { askQuestion: null }
            : {}),
          ...(message.planReview?.requestId === event.requestId
            ? {
              planReview: {
                ...message.planReview,
                resolved: "rejected" as const,
              },
            }
            : {}),
        }));
        return;
      }

      if (event.type === "turn_completed") {
        if (event.error && !visibleProviderErrorsRef.current[tabId]) {
          surfaceProviderError(tabId, event.error, true);
        }
        delete visibleProviderErrorsRef.current[tabId];
        lifecycle.finishTurn(tabId);
        updateTabLastAssistant(tabId, () => ({ streaming: false }));
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  generating: false,
                  ...(event.contextWindow
                    ? { contextWindow: event.contextWindow }
                    : {}),
                }
              : tab,
          ),
        }));

        if (options.autoGenerateTitles && provider.generateTitle) {
          const currentTab = stateRef.current.tabs.find((tab) => tab.id === tabId);
          const firstUser = currentTab?.messages.find(
            (message) => message.role === "user" && !message.isCompaction,
          );
          const firstAssistant = currentTab?.messages.find(
            (message) => message.role === "assistant" && !message.isCompaction,
          );
          if (currentTab && firstUser && firstAssistant) {
            const userText = firstUser.displayText || firstUser.content;
            const truncatedTitle =
              userText.slice(0, 40) + (userText.length > 40 ? "..." : "");
            const needsTitle =
              currentTab.title === "New conversation" ||
              currentTab.title === truncatedTitle;
            if (needsTitle && userText) {
              const titleBeforeGeneration = currentTab.title;
              provider
                .generateTitle({
                  userMessage: userText,
                  assistantMessage: firstAssistant.content,
                })
                .then((generatedTitle) => {
                  if (!generatedTitle) return;
                  const tab = stateRef.current.tabs.find((item) => item.id === tabId);
                  if (!tab || tab.title !== titleBeforeGeneration) return;
                  renameTab(tabId, generatedTitle);
                })
                .catch((error) => console.error("[hyo][title] Error:", error));
            }
          }
        }
        return;
      }

      if (event.type === "token_usage") {
        setState((prev) => ({
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId ? {
              ...tab,
              inputTokens: event.inputTokens,
              ...(event.contextWindow && event.contextWindow > 0
                ? { contextWindow: event.contextWindow }
                : {}),
            } : tab,
          ),
        }));
        return;
      }

      if (event.type === "content_blocks") {
        processContentBlocks(event.blocks, ss, event.source);
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

      if (event.type === "agent_message_completed") {
        applyAgentMessageCompletion(
          ss.orderedBlocks,
          ss.turnIndex,
          event.itemId,
          event.text,
        );
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

      if (event.type === "tool_activity") {
        let tool = ss.toolCalls.find((item) => item.id === event.tool.id);
        const input = event.tool.input ??
          (event.tool.changes ? { changes: event.tool.changes } : event.tool.metadata ?? {});
        if (!tool) {
          tool = {
            id: event.tool.id,
            name: event.tool.name,
            input,
            result: null,
          };
          ss.toolCalls.push(tool);
          ss.orderedBlocks.push({
            type: "tool",
            toolId: tool.id,
            turnIndex: ss.turnIndex,
          });
        } else {
          tool.name = event.tool.name || tool.name;
          if (event.tool.input !== undefined || event.tool.changes || event.tool.metadata) {
            tool.input = input;
          }
        }
        if (event.tool.outputDelta) {
          tool.result = `${tool.result ?? ""}${event.tool.outputDelta}`;
        }
        if (event.tool.output !== undefined) {
          tool.result = serializeProviderValue(event.tool.output);
        } else if (event.phase === "completed" && !event.tool.outputDelta) {
          tool.result = event.tool.status || "completed";
        }
        if (event.phase === "completed") ss.toolResultSinceLastText = true;
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

      if (event.type === "subagent_activity" || event.type === "subagent_status") {
        const name = event.type === "subagent_activity"
          ? event.operation
          : `subagent_${event.activity}`;
        const input = event.type === "subagent_activity"
          ? {
              prompt: event.prompt,
              senderThreadId: event.senderThreadId,
              receiverThreadIds: event.receiverThreadIds,
              newThreadIds: event.newThreadIds,
            }
          : { agentThreadId: event.agentThreadId, agentPath: event.agentPath };
        const result = event.type === "subagent_activity"
          ? serializeProviderValue({ status: event.status, agents: event.agents })
          : serializeProviderValue({ phase: event.phase });
        const existing = ss.toolCalls.find((item) => item.id === event.id);
        if (existing) {
          existing.name = name;
          existing.input = input;
          existing.result = event.phase === "completed" ? result : existing.result;
        } else {
          ss.toolCalls.push({
            id: event.id,
            name,
            input,
            result: event.phase === "completed" ? result : null,
          });
          ss.orderedBlocks.push({
            type: "tool",
            toolId: event.id,
            turnIndex: ss.turnIndex,
          });
        }
        if (event.phase === "completed") ss.toolResultSinceLastText = true;
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

      if (event.type === "tool_started") {
        const tool: ToolCallData = { ...event.tool, result: null };
        if (!ss.toolCalls.find((item) => item.id === tool.id)) {
          ss.toolCalls.push(tool);
          ss.orderedBlocks.push({
            type: "tool",
            toolId: tool.id,
            turnIndex: ss.turnIndex,
          });
          if (tool.name === "Skill") {
            for (const block of ss.orderedBlocks) {
              if (block.type === "text" && block.turnIndex === ss.turnIndex) {
                block.isSkillOutput = true;
              }
            }
          }
          updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        }
        return;
      }

      if (event.type === "tool_input_delta") {
        const lastTool = ss.toolCalls[ss.toolCalls.length - 1];
        if (lastTool) {
          lastTool._inputJson = (lastTool._inputJson || "") + event.delta;
          try {
            lastTool.input = JSON.parse(lastTool._inputJson);
          } catch {
            // Partial JSON is expected while the provider is streaming.
          }
        }
        return;
      }

      if (event.type === "tool_stopped") {
        const lastBlock = ss.orderedBlocks[ss.orderedBlocks.length - 1];
        if (lastBlock?.type === "tool") ss.toolResultSinceLastText = true;
        return;
      }

      if (event.type === "text_delta") {
        if (ss.toolResultSinceLastText && ss.orderedBlocks.length > 0) {
          ss.turnIndex++;
        }
        applyProviderTextDelta(
          ss.orderedBlocks,
          ss.turnIndex,
          event.itemId,
          event.delta,
        );
        ss.toolResultSinceLastText = false;
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

      if (event.type === "thinking_delta") {
        const existing = ss.orderedBlocks.find(
          (block) =>
            block.type === "thinking" && block.turnIndex === ss.turnIndex,
        );
        if (existing) existing.content = (existing.content || "") + event.delta;
        else {
          ss.orderedBlocks.push({
            type: "thinking",
            content: event.delta,
            turnIndex: ss.turnIndex,
          });
        }
        updateTabLastAssistant(tabId, () => buildSnapshot(ss));
        return;
      }

    },
    [
      options.autoGenerateTitles,
      surfaceProviderError,
      updateTabLastAssistant,
    ],
  );

  // ------- tab management -------

  const newTab = useCallback(() => {
    const id = genId();
    const providerDefaults = providerDefaultsFor(options, defaultProviderId);
    setState((prev) => {
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            providerId: defaultProviderId,
            providerSessionId: null,
            providerState: null,
            runtimeConfiguration: {
              cwd: options.cwd,
              maxOutputTokens: options.maxOutputTokens,
            },
            title: "New conversation",
            messages: [],
            generating: false,
            ...providerDefaults,
            permissionMode: options.permissionMode,
            agent: options.defaultAgent,
            inputTokens: 0,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [defaultProviderId, options.cwd, options.defaultAgent, options.maxOutputTokens, options.model, options.permissionMode, options.providerDefaults]);

  const closeTab = useCallback((tabIdToClose: string) => {
    lifecycleRef.current.cleanupRuntime(tabIdToClose);
    delete streamStatesRef.current[tabIdToClose];

    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabIdToClose);

      if (remaining.length === 0) {
        const newId = genId();
        const providerDefaults = providerDefaultsFor(options, defaultProviderId);
        return {
          tabs: [
            {
              id: newId,
              providerId: defaultProviderId,
              providerSessionId: null,
              providerState: null,
              runtimeConfiguration: {
                cwd: options.cwd,
                maxOutputTokens: options.maxOutputTokens,
              },
              title: "New conversation",
              messages: [],
              generating: false,
              ...providerDefaults,
              permissionMode: options.permissionMode,
              agent: options.defaultAgent,
              inputTokens: 0,
              voiceMode: false,
            },
          ],
          activeTabId: newId,
        };
      }

      let activeTabId = prev.activeTabId;
      if (prev.activeTabId === tabIdToClose) {
        const idx = prev.tabs.findIndex((t) => t.id === tabIdToClose);
        const newIdx = Math.min(idx, remaining.length - 1);
        activeTabId = remaining[newIdx].id;
      }

      return { tabs: remaining, activeTabId };
    });
  }, [defaultProviderId, options.cwd, options.defaultAgent, options.maxOutputTokens, options.model, options.permissionMode, options.providerDefaults]);

  const switchTab = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeTabId: id }));
    scrollRef.current.nearBottom = true;
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    const tab = stateRef.current.tabs.find((item) => item.id === id);
    if (tab?.providerSessionId) {
      const provider = resolveProvider(tab.providerId);
      const cwd = tab.runtimeConfiguration?.cwd ?? options.cwd;
      void provider
        .renameSession(cwd, tab.providerSessionId, title)
        .then(() => refreshPastSessions(tab.providerId))
        .catch((error) => {
          console.error("[hyo] Failed to rename session:", error);
        });
    }
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((item) =>
        item.id === id ? { ...item, title } : item
      ),
    }));
  }, [options.cwd]); // refreshPastSessions intentionally omitted — declared later, referenced via closure

  // ------- messaging -------

  const sendMessage = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; isCompaction?: boolean }) => {
      const tabId = stateRef.current.activeTabId;
      const owningTab = stateRef.current.tabs.find((tab) => tab.id === tabId);
      if (!owningTab) return false;
      const provider = resolveProvider(owningTab.providerId);
      const lifecycle = lifecycleRef.current;
      if (!lifecycle.beginTurn(tabId)) return false;
      turnGenerationRef.current[tabId] =
        (turnGenerationRef.current[tabId] ?? 0) + 1;
      delete visibleProviderErrorsRef.current[tabId];

      // For display, use the typed text; for arrays (image messages) use displayText or placeholder
      const displayContent = typeof content === "string"
        ? (meta?.displayText ?? content)
        : (meta?.displayText ?? "");

      const userMsg: Message = {
        role: "user",
        content: displayContent,
        displayText: meta?.displayText,
        attachments: meta?.attachedFileNames?.map((name) => ({ type: "file", name })),
        isCompaction: meta?.isCompaction,
      };
      const assistantMsg: Message = {
        role: "assistant",
        content: "",
        thinking: "",
        toolCalls: [],
        orderedBlocks: [],
        streaming: true,
        isCompaction: meta?.isCompaction,
      };

      streamStatesRef.current[tabId] = {
        toolCalls: [],
        orderedBlocks: [],
        turnIndex: 0,
        toolResultSinceLastText: false,
        skillResultPending: false,
      };

      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((tab) => {
          if (tab.id !== tabId) return tab;
          const titleText = meta?.displayText ?? (typeof content === "string" ? content : "");
          const title =
            tab.messages.length === 0 && tab.title === "New conversation"
              ? titleText.slice(0, 40) + (titleText.length > 40 ? "..." : "")
              : tab.title;
          // Compaction: don't add a user message — just the streaming assistant marker
          const newMessages = meta?.isCompaction
            ? [
                ...tab.messages.map((message) =>
                  message.role === "assistant" && message.streaming
                    ? { ...message, streaming: false }
                    : message,
                ),
                assistantMsg,
              ]
            : [
                ...tab.messages.map((message) =>
                  message.role === "assistant" && message.streaming
                    ? { ...message, streaming: false }
                    : message,
                ),
                userMsg,
                assistantMsg,
              ];
          return {
            ...tab,
            title,
            messages: newMessages,
            generating: true,
          };
        }),
      }));
      scrollRef.current.nearBottom = true;

      let runtime = lifecycle.getRuntime(tabId);
      if (runtime && !runtime.isRunning()) runtime = undefined;
      if (!runtime) {
        const currentTab = stateRef.current.tabs.find((tab) => tab.id === tabId);
        const providerSessionId = currentTab?.providerSessionId;
        let dispatchEvent: (event: ProviderEvent) => void = () => {};
        runtime = provider.createRuntime({
          cwd: currentTab?.runtimeConfiguration?.cwd ?? options.cwd,
          model: currentTab?.model ?? providerDefaultsFor(options, owningTab.providerId).model,
          reasoningEffort: currentTab?.reasoningEffort,
          approvalPolicy: currentTab?.approvalPolicy,
          sandboxMode: currentTab?.sandboxMode,
          networkAccess: currentTab?.networkAccess,
          permissionMode: currentTab?.permissionMode || options.permissionMode,
          agent: currentTab?.agent || "",
          providerSessionId: providerSessionId || undefined,
          providerState: currentTab?.providerState,
          resume: !!providerSessionId,
          maxOutputTokens: currentTab?.runtimeConfiguration
            ? currentTab.runtimeConfiguration.maxOutputTokens
            : options.maxOutputTokens,
          onEvent: (event) => dispatchEvent(event),
        });
        const lease = lifecycle.attachRuntime(tabId, runtime);
        dispatchEvent = makeProcessEvent(tabId, lease, provider);
        try {
          runtime.start();
        } catch (error) {
          lifecycle.cleanupRuntime(tabId);
          throw error;
        }
      }

      try {
        if (meta?.isCompaction) runtime.compact();
        else runtime.send(content);
      } catch (error) {
        lifecycle.finishTurn(tabId);
        throw error;
      }
      return true;
    },
    [options, makeProcessEvent]
  );

  const sendPermissionResponse = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      const tabId = stateRef.current.activeTabId;
      // Look up the toolName from the pending permission request so the
      // transport can build the correct updatedPermissions for "always allow".
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const lastMsg = tab?.messages[tab.messages.length - 1];
      const permissionMatches =
        lastMsg?.permissionRequest?.requestId === requestId &&
        !lastMsg.permissionRequest.resolved;
      const planMatches =
        lastMsg?.planReview?.requestId === requestId &&
        !lastMsg.planReview.resolved;
      if (!permissionMatches && !planMatches) return;
      const toolName = lastMsg?.permissionRequest?.toolName;
      lifecycleRef.current.getRuntime(tabId)?.respondApproval(
        requestId,
        behavior,
        toolName,
      );
      updateTabLastAssistant(tabId, (msg) => {
        const updates: Partial<Message> = {};
        if (msg.permissionRequest?.requestId === requestId) {
          updates.permissionRequest = {
            ...msg.permissionRequest,
            resolved: behavior === "deny" ? ("denied" as const) : ("allowed" as const),
          };
        }
        // Also resolve planReview if this requestId matches
        if (msg.planReview && msg.planReview.requestId === requestId) {
          updates.planReview = {
            ...msg.planReview,
            resolved: behavior === "deny" ? ("rejected" as const) : ("approved" as const),
          };
        }
        return updates;
      });
    },
    [updateTabLastAssistant]
  );

  const sendQuestionAnswer = useCallback(
    (questionId: string, answers: Record<string, string>) => {
      const tabId = stateRef.current.activeTabId;

      // AskUserQuestion's input schema requires "questions" — updatedInput
      // must satisfy the tool's original input schema, not just carry the
      // answers. Echo back the questions we already have from the tab's
      // askQuestion state alongside the answers.
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const lastAssistant = [...(tab?.messages || [])]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant?.askQuestion?.id !== questionId) return;
      const questions = lastAssistant?.askQuestion?.questions || [];

      // Send control_response with questions + answers as updatedInput.
      // The CLI was blocked on the control_request — this unblocks it.
      // Claude receives the answers and continues within the same turn.
      lifecycleRef.current.getRuntime(tabId)?.respondQuestion(
        questionId,
        questions,
        answers,
      );

      // Clear the question UI. The assistant message stays streaming —
      // Claude will continue and the result event will finalize it.
      updateTabLastAssistant(tabId, () => ({ askQuestion: null }));
    },
    [updateTabLastAssistant]
  );

  const stopGeneration = useCallback(() => {
    const tabId = stateRef.current.activeTabId;
    const runtime = lifecycleRef.current.getRuntime(tabId);
    try {
      runtime?.interrupt();
    } finally {
      lifecycleRef.current.cleanupRuntime(tabId);
    }
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, generating: false } : tab
      ),
    }));
    updateTabLastAssistant(tabId, () => ({ streaming: false }));
  }, [updateTabLastAssistant]);

  const setTabProviderOptions = useCallback((updates: Partial<ProviderSessionOptions>) => {
    const tabId = stateRef.current.activeTabId;
    lifecycleRef.current.cleanupRuntime(tabId);
    delete streamStatesRef.current[tabId];
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const provider = resolveProvider(tab.providerId);
        return {
          ...tab,
          ...updates,
          generating: false,
          messages: tab.messages.map((message) =>
            message.role === "assistant" && message.streaming
              ? { ...message, streaming: false }
              : message,
          ),
          ...(updates.model
            ? { model: provider.normalizeModelId?.(updates.model) ?? updates.model }
            : {}),
        };
      }),
    }));
  }, []);

  const setTabModel = useCallback((model: string) => {
    setTabProviderOptions({ model });
  }, [setTabProviderOptions]);

  const setTabReasoningEffort = useCallback((reasoningEffort?: string) => {
    setTabProviderOptions({ reasoningEffort });
  }, [setTabProviderOptions]);

  const setTabApprovalPolicy = useCallback((
    approvalPolicy?: ProviderSessionOptions["approvalPolicy"],
  ) => {
    setTabProviderOptions({ approvalPolicy });
  }, [setTabProviderOptions]);

  const setTabSandboxMode = useCallback((
    sandboxMode?: ProviderSessionOptions["sandboxMode"],
  ) => {
    setTabProviderOptions({ sandboxMode });
  }, [setTabProviderOptions]);

  const setTabNetworkAccess = useCallback((networkAccess?: boolean) => {
    setTabProviderOptions({ networkAccess });
  }, [setTabProviderOptions]);

  const setTabPermissionMode = useCallback((permissionMode: string) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, permissionMode } : tab
      ),
    }));
  }, []);

  const toggleVoiceMode = useCallback(() => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId
          ? { ...tab, voiceMode: !tab.voiceMode }
          : tab
      ),
    }));
  }, []);

  const setTabAgent = useCallback((agent: string) => {
    // Switching agents requires a fresh CLI process — kill the current transport.
    // Next sendMessage will respawn with the new --agent flag.
    setState((prev) => {
      const tabId = prev.activeTabId;
      lifecycleRef.current.cleanupRuntime(tabId);
      delete streamStatesRef.current[tabId];
      return {
        ...prev,
        tabs: prev.tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, agent, providerSessionId: null, providerState: null }
            : tab
        ),
      };
    });
  }, []);

  // ------- past sessions -------

  const activeProviderIdForHistory =
    state.tabs.find((tab) => tab.id === state.activeTabId)?.providerId ??
    defaultProviderId;

  const refreshPastSessions = useCallback(async (requestedProviderId?: ProviderId) => {
    const activeProviderId =
      stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeTabId)?.providerId ??
      defaultProviderId;
    const providerId = requestedProviderId ?? activeProviderId;
    if (providerId !== activeProviderId) return;
    const provider = resolveProvider(providerId);
    const request = ++historyRequestRef.current;
    try {
      const sessions = await provider.listSessions(options.cwd);
      const currentActiveProviderId = stateRef.current.tabs.find(
        (tab) => tab.id === stateRef.current.activeTabId,
      )?.providerId;
      if (
        !mountedRef.current ||
        request !== historyRequestRef.current ||
        currentActiveProviderId !== providerId ||
        latestProvidersRef.current.get(providerId) !== provider
      ) return;
      if (sessions.length === 0 && pastSessionsRef.current.length === 0) return;
      const nextSessions = sessions.map((session) => ({ ...session, providerId }));
      setPastSessions((prev) => {
        const latestActiveProviderId = stateRef.current.tabs.find(
          (tab) => tab.id === stateRef.current.activeTabId,
        )?.providerId;
        if (
          !mountedRef.current ||
          request !== historyRequestRef.current ||
          latestActiveProviderId !== providerId ||
          latestProvidersRef.current.get(providerId) !== provider
        ) return prev;
        return nextSessions;
      });
    } catch (e) {
      if (mountedRef.current && latestProvidersRef.current.get(providerId) === provider) {
        console.error("[hyo] Failed to list past sessions:", e);
      }
    }
  }, [defaultProviderId, options.cwd]);

  useEffect(() => {
    if (pastSessionsRef.current.length > 0) {
      pastSessionsRef.current = [];
      setPastSessions([]);
    }
    void refreshPastSessions();
  }, [activeProviderIdForHistory, defaultProviderId, refreshPastSessions, registry]);

  const openPastSession = useCallback(async (pastSession: PastSession) => {
    const existing = stateRef.current.tabs.find(
      (tab) =>
        tab.providerId === pastSession.providerId &&
        tab.providerSessionId === pastSession.id,
    );
    if (existing) {
      openIntentRef.current++;
      setState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }

    const provider = resolveProvider(pastSession.providerId);
    const providerOpenings = openingSessionsRef.current.get(provider) ?? new Set<string>();
    openingSessionsRef.current.set(provider, providerOpenings);
    const openingKey = `${pastSession.providerId}\u0000${pastSession.id}`;
    if (providerOpenings.has(openingKey)) return;
    providerOpenings.add(openingKey);

    const openIntent = ++openIntentRef.current;
    const activeTabIdAtStart = stateRef.current.activeTabId;
    const activeProviderIdAtStart = stateRef.current.tabs.find(
      (tab) => tab.id === activeTabIdAtStart,
    )?.providerId;
    const defaultProviderIdAtStart = defaultProviderId;
    let history: ProviderHistoryMessage[];
    try {
      history = await provider.loadSession(options.cwd, pastSession.id);
    } catch (error) {
      if (mountedRef.current && openIntent === openIntentRef.current) {
        console.error("[hyo] Failed to load session:", error);
      }
      return;
    } finally {
      providerOpenings.delete(openingKey);
    }
    const activeProviderId = stateRef.current.tabs.find(
      (tab) => tab.id === stateRef.current.activeTabId,
    )?.providerId;
    if (
      !mountedRef.current ||
      openIntent !== openIntentRef.current ||
      latestProvidersRef.current.get(pastSession.providerId) !== provider ||
      stateRef.current.activeTabId !== activeTabIdAtStart ||
      activeProviderId !== activeProviderIdAtStart ||
      defaultProviderIdRef.current !== defaultProviderIdAtStart
    ) return;
    const openedWhileLoading = stateRef.current.tabs.find(
      (tab) =>
        tab.providerId === pastSession.providerId &&
        tab.providerSessionId === pastSession.id,
    );
    if (openedWhileLoading) {
      setState((prev) => {
        const activeTab = prev.tabs.find((tab) => tab.id === prev.activeTabId);
        const existingTab = prev.tabs.find(
          (tab) =>
            tab.providerId === pastSession.providerId &&
            tab.providerSessionId === pastSession.id,
        );
        if (
          !mountedRef.current ||
          openIntent !== openIntentRef.current ||
          latestProvidersRef.current.get(pastSession.providerId) !== provider ||
          prev.activeTabId !== activeTabIdAtStart ||
          activeTab?.providerId !== activeProviderIdAtStart ||
          defaultProviderIdRef.current !== defaultProviderIdAtStart ||
          !existingTab
        ) return prev;
        return { ...prev, activeTabId: existingTab.id };
      });
      return;
    }
    const messages: Message[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking || "",
      toolCalls: m.toolCalls || [],
      orderedBlocks: m.orderedBlocks || [],
      streaming: false,
    }));

    const id = genId();
    const providerDefaults = providerDefaultsFor(options, pastSession.providerId);
    setState((prev) => {
      const currentActiveTab = prev.tabs.find((tab) => tab.id === prev.activeTabId);
      if (
        !mountedRef.current ||
        openIntent !== openIntentRef.current ||
        latestProvidersRef.current.get(pastSession.providerId) !== provider ||
        prev.activeTabId !== activeTabIdAtStart ||
        currentActiveTab?.providerId !== activeProviderIdAtStart ||
        defaultProviderIdRef.current !== defaultProviderIdAtStart
      ) return prev;
      const existingTab = prev.tabs.find(
        (tab) =>
          tab.providerId === pastSession.providerId &&
          tab.providerSessionId === pastSession.id,
      );
      if (existingTab) return { ...prev, activeTabId: existingTab.id };
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            providerId: pastSession.providerId,
            providerSessionId: pastSession.id,
            providerState: pastSession.providerState ?? null,
            runtimeConfiguration: {
              cwd: options.cwd,
              maxOutputTokens: options.maxOutputTokens,
            },
            title: pastSession.title,
            messages,
            generating: false,
            ...providerDefaults,
            permissionMode: options.permissionMode,
            agent: options.defaultAgent,
            inputTokens: 0,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [defaultProviderId, options.cwd, options.maxOutputTokens, options.model, options.permissionMode, options.defaultAgent, options.providerDefaults]);

  const compact = useCallback(() => {
    return sendMessage("/compact", { isCompaction: true });
  }, [sendMessage]);

  // Recover a session that's been poisoned by an orphaned `thinking` block
  // (the result of an output-cap mid-stream truncation). Reads the .jsonl,
  // surgically removes the orphan + cap-error + failed retries, repairs
  // parent UUIDs, kills the broken transport so the next send re-spawns
  // with `--resume` against the cleaned file. Returns the user's last
  // attempted message text so the UI can prefill the input.
  const recoverSession = useCallback(
    async (tabId: string): Promise<ProviderRecoveryResult> => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab?.providerSessionId) {
        return {
          success: false,
          linesRemoved: 0,
          capturedUserText: null,
          reason: "No session ID for this tab",
        };
      }

      const provider = resolveProvider(tab.providerId);
      const result = await provider.recoverSession(
        tab.runtimeConfiguration?.cwd ?? options.cwd,
        tab.providerSessionId,
      );
      if (!result.success) return result;

      // Kill the existing transport so the next sendMessage spawns a fresh
      // process that --resumes against the cleaned file.
      const existing = lifecycleRef.current.getRuntime(tabId);
      if (existing) {
        try {
          lifecycleRef.current.cleanupRuntime(tabId);
        } catch {}
      }

      // Strip the corrupt trailing messages from the in-memory state so the
      // chat UI matches the file. Walk back from the end, removing assistant
      // API errors and the user retries that triggered them, plus any
      // orphaned-cap residue.
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== tabId) return t;
          const msgs = [...t.messages];
          while (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const text = (last.content || "").trim();
            const isApiError =
              last.role === "assistant" &&
              (text.startsWith("API Error") ||
                provider.isRecoverableError?.(text));
            const isFailedUserRetry =
              last.role === "user" &&
              msgs.length >= 2 &&
              ((msgs[msgs.length - 2].content || "").startsWith("API Error") ||
                provider.isRecoverableError?.(
                  msgs[msgs.length - 2].content || "",
                ));
            if (isApiError || isFailedUserRetry) {
              msgs.pop();
            } else {
              break;
            }
          }
          return { ...t, messages: msgs, generating: false };
        }),
      }));

      return result;
    },
    [options.cwd]
  );

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const activeProvider = effectiveProviderMap.get(
    activeTab?.providerId ?? defaultProviderId,
  );
  if (!activeProvider) {
    throw new Error(
      `Provider "${activeTab?.providerId ?? defaultProviderId}" is not registered`,
    );
  }

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeMessages: activeTab?.messages || [],
    activeGenerating: activeTab?.generating || false,
    activeModel:
      activeTab?.model ??
      providerDefaultsFor(options, activeTab?.providerId ?? defaultProviderId).model,
    activePermissionMode: activeTab?.permissionMode || options.permissionMode,
    activeAgent: activeTab?.agent || "",
    activeVoiceMode: activeTab?.voiceMode || false,
    activeTabHasSession: !!activeTab?.providerSessionId,
    activeInputTokens: activeTab?.inputTokens || 0,
    activeContextWindow: activeTab?.contextWindow,
    activeProviderId: activeProvider.id,
    activeProvider,
    activeProviderCapabilities: activeProvider.capabilities,
    activeProviderOptions: {
      model:
        activeTab?.model ??
        providerDefaultsFor(options, activeTab?.providerId ?? defaultProviderId).model,
      reasoningEffort: activeTab?.reasoningEffort,
      approvalPolicy: activeTab?.approvalPolicy,
      sandboxMode: activeTab?.sandboxMode,
      networkAccess: activeTab?.networkAccess,
    } satisfies ProviderSessionOptions,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTabModel,
    setTabProviderOptions,
    setTabReasoningEffort,
    setTabApprovalPolicy,
    setTabSandboxMode,
    setTabNetworkAccess,
    setTabPermissionMode,
    setTabAgent,
    toggleVoiceMode,
    sendMessage,
    sendPermissionResponse,
    sendQuestionAnswer,
    stopGeneration,
    compact,
    recoverSession,
    pastSessions,
    openPastSession,
    refreshPastSessions,
    scrollRef,
  };
}
