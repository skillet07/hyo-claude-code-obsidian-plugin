import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type {
  Message,
  ToolCallData,
  OrderedBlock,
} from "../chat-types";
import { ProviderRegistry } from "../providers/registry";
import { createClaudeProvider } from "../providers/claude/provider";
import type {
  ProviderContentBlock,
  ProviderEvent,
  ProviderId,
  ProviderRecoveryResult,
  ProviderRuntime,
  ProviderSessionSummary,
} from "../providers/types";
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
  title: string;
  messages: Message[];
  generating: boolean;
  model: string;
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

interface SessionManagerOptions {
  cliPath: string;
  cwd: string;
  model: string;
  permissionMode: string;
  defaultAgent: string;
  maxOutputTokens?: number;
  settingsVersion?: number;
  autoGenerateTitles?: boolean;
}

// ------- utilities -------

function genId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
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

// ------- hook -------

export function useSessionManager(options: SessionManagerOptions) {
  const provider = useMemo(
    () =>
      new ProviderRegistry([
        createClaudeProvider({ cliPath: options.cliPath }),
      ]).resolve("claude"),
    [options.cliPath],
  );
  const [state, setState] = useState<SessionState>(() => {
    const id = genId();
    return {
      tabs: [
        {
          id,
          providerId: "claude",
          providerSessionId: null,
          providerState: null,
          title: "New conversation",
          messages: [],
          generating: false,
          model: options.model,
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

  const lifecycleRef = useRef(new SessionLifecycle<ProviderRuntime>());
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const scrollRef = useRef({ nearBottom: true });
  const stateRef = useRef(state);
  stateRef.current = state;

  // Detach leases before provider teardown so close callbacks cannot mutate a
  // successor. The provider is the sole teardown owner for this cleanup path.
  useEffect(() => {
    return () => {
      lifecycleRef.current.detachAll();
      provider.cleanup();
    };
  }, [provider]);

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

  const makeProcessEvent = useCallback(
    (tabId: string, lease: RuntimeLease) => (event: ProviderEvent) => {
      const lifecycle = lifecycleRef.current;
      if (!lifecycle.ownsRuntime(lease)) return;

      if (event.type === "error") {
        console.error("[hyo] Provider error:", event.message);
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
          const errorMsg: Message = {
            role: "assistant",
            content: `_Claude process exited unexpectedly (code ${event.exitCode}). Start a new conversation to continue._`,
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
          setTimeout(() => {
            lifecycleRef.current.getRuntime(tabId)?.send(
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
        updateTabLastAssistant(tabId, (message) => ({
          askQuestion: message.askQuestion
            ? { ...message.askQuestion, id: event.requestId }
            : {
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

      if (event.type === "turn_completed") {
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
            tab.id === tabId ? { ...tab, inputTokens: event.inputTokens } : tab,
          ),
        }));
        return;
      }

      if (event.type === "content_blocks") {
        processContentBlocks(event.blocks, ss, event.source);
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
        const existing = ss.orderedBlocks.find(
          (block) => block.type === "text" && block.turnIndex === ss.turnIndex,
        );
        if (existing) existing.content = (existing.content || "") + event.delta;
        else {
          ss.orderedBlocks.push({
            type: "text",
            content: event.delta,
            turnIndex: ss.turnIndex,
          });
        }
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
    [options.autoGenerateTitles, provider, updateTabLastAssistant],
  );

  // ------- tab management -------

  const newTab = useCallback(() => {
    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            providerId: "claude",
            providerSessionId: null,
            providerState: null,
            title: "New conversation",
            messages: [],
            generating: false,
            model: activeTab?.model || options.model,
            permissionMode: activeTab?.permissionMode || options.permissionMode,
            agent: options.defaultAgent,
            inputTokens: 0,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.model, options.permissionMode]);

  const closeTab = useCallback((tabIdToClose: string) => {
    lifecycleRef.current.cleanupRuntime(tabIdToClose);
    delete streamStatesRef.current[tabIdToClose];

    setState((prev) => {
      const remaining = prev.tabs.filter((t) => t.id !== tabIdToClose);

      if (remaining.length === 0) {
        const newId = genId();
        return {
          tabs: [
            {
              id: newId,
              providerId: "claude",
              providerSessionId: null,
              providerState: null,
              title: "New conversation",
              messages: [],
              generating: false,
              model: options.model,
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
  }, []);

  const switchTab = useCallback((id: string) => {
    setState((prev) => ({ ...prev, activeTabId: id }));
    scrollRef.current.nearBottom = true;
  }, []);

  const renameTab = useCallback((id: string, title: string) => {
    setState((prev) => {
      const tab = prev.tabs.find((t) => t.id === id);

      // If this tab has a persisted session, save the custom title and refresh dropdown
      if (tab?.providerSessionId) {
        provider.renameSession(options.cwd, tab.providerSessionId, title);
        // Refresh past sessions to update dropdown
        setTimeout(() => refreshPastSessions(), 0);
      }

      return {
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.id === id ? { ...t, title } : t
        ),
      };
    });
  }, [options.cwd, provider]); // refreshPastSessions intentionally omitted — declared later, referenced via closure

  // ------- messaging -------

  const sendMessage = useCallback(
    (content: string | any[], meta?: { displayText?: string; attachedFileNames?: string[]; isCompaction?: boolean }) => {
      const tabId = stateRef.current.activeTabId;
      const lifecycle = lifecycleRef.current;
      if (!lifecycle.beginTurn(tabId)) return false;

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
            ? [...tab.messages, assistantMsg]
            : [...tab.messages, userMsg, assistantMsg];
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
          cwd: options.cwd,
          model: currentTab?.model || options.model,
          permissionMode: currentTab?.permissionMode || options.permissionMode,
          agent: currentTab?.agent || "",
          providerSessionId: providerSessionId || undefined,
          resume: !!providerSessionId,
          maxOutputTokens: options.maxOutputTokens,
          onEvent: (event) => dispatchEvent(event),
        });
        const lease = lifecycle.attachRuntime(tabId, runtime);
        dispatchEvent = makeProcessEvent(tabId, lease);
        try {
          runtime.start();
        } catch (error) {
          lifecycle.cleanupRuntime(tabId);
          throw error;
        }
      }

      try {
        runtime.send(content);
      } catch (error) {
        lifecycle.finishTurn(tabId);
        throw error;
      }
      return true;
    },
    [options, makeProcessEvent, provider]
  );

  const sendPermissionResponse = useCallback(
    (requestId: string, behavior: "allow" | "allow_always" | "deny") => {
      const tabId = stateRef.current.activeTabId;
      // Look up the toolName from the pending permission request so the
      // transport can build the correct updatedPermissions for "always allow".
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      const lastMsg = tab?.messages[tab.messages.length - 1];
      const toolName = lastMsg?.permissionRequest?.toolName;
      lifecycleRef.current.getRuntime(tabId)?.respondApproval(
        requestId,
        behavior,
        toolName,
      );
      updateTabLastAssistant(tabId, (msg) => {
        const updates: Partial<Message> = {};
        if (msg.permissionRequest) {
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

  const setTabModel = useCallback((model: string) => {
    const normalized = provider.normalizeModelId?.(model) ?? model;
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) =>
        tab.id === prev.activeTabId ? { ...tab, model: normalized } : tab
      ),
    }));
  }, [provider]);

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

  const refreshPastSessions = useCallback(() => {
    try {
      const sessions = provider.listSessions(options.cwd);
      setPastSessions(sessions);
    } catch (e) {
      console.error("[hyo] Failed to list past sessions:", e);
    }
  }, [options.cwd, provider]);

  useEffect(() => {
    refreshPastSessions();
  }, [refreshPastSessions]);

  const openPastSession = useCallback((pastSession: PastSession) => {
    const existing = stateRef.current.tabs.find(
      (tab) =>
        tab.providerId === pastSession.providerId &&
        tab.providerSessionId === pastSession.id,
    );
    if (existing) {
      setState((prev) => ({ ...prev, activeTabId: existing.id }));
      return;
    }

    // Load conversation history from JSONL
    const history = provider.loadSession(options.cwd, pastSession.id);
    const messages: Message[] = history.map((m) => ({
      role: m.role,
      content: m.content,
      thinking: m.thinking || "",
      toolCalls: m.toolCalls || [],
      orderedBlocks: m.orderedBlocks || [],
      streaming: false,
    }));

    const id = genId();
    setState((prev) => {
      const activeTab = prev.tabs.find((t) => t.id === prev.activeTabId);
      return {
        tabs: [
          ...prev.tabs,
          {
            id,
            providerId: pastSession.providerId,
            providerSessionId: pastSession.id,
            providerState: pastSession.providerState ?? null,
            title: pastSession.title,
            messages,
            generating: false,
            model: activeTab?.model || options.model,
            permissionMode: activeTab?.permissionMode || options.permissionMode,
            agent: options.defaultAgent,
            inputTokens: 0,
            voiceMode: false,
          },
        ],
        activeTabId: id,
      };
    });
  }, [options.cwd, options.model, options.permissionMode, options.defaultAgent, provider]);

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
    (tabId: string): ProviderRecoveryResult => {
      const tab = stateRef.current.tabs.find((t) => t.id === tabId);
      if (!tab?.providerSessionId) {
        return {
          success: false,
          linesRemoved: 0,
          capturedUserText: null,
          reason: "No session ID for this tab",
        };
      }

      const result = provider.recoverSession(
        options.cwd,
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
    [options.cwd, provider]
  );

  // ------- return -------

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeMessages: activeTab?.messages || [],
    activeGenerating: activeTab?.generating || false,
    activeModel: activeTab?.model || options.model,
    activePermissionMode: activeTab?.permissionMode || options.permissionMode,
    activeAgent: activeTab?.agent || "",
    activeVoiceMode: activeTab?.voiceMode || false,
    activeTabHasSession: !!activeTab?.providerSessionId,
    activeInputTokens: activeTab?.inputTokens || 0,
    activeContextWindow: activeTab?.contextWindow,
    newTab,
    closeTab,
    switchTab,
    renameTab,
    setTabModel,
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
