import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";

vi.mock("./MarkdownBlock", () => ({ MarkdownBlock: () => null }));
vi.mock("./PlanReview", () => ({ PlanReview: () => null }));

import { StreamingMessage } from "./StreamingMessage";
import { ChatMessage } from "./ChatMessage";
import { PermissionRequest } from "./PermissionRequest";
import { AskQuestion } from "./AskQuestion";

let renderer: ReactTestRenderer | undefined;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { if (renderer) act(() => renderer?.unmount()); renderer = undefined; });

describe("StreamingMessage pending controls", () => {
  it("renders every parallel approval and question independently", () => {
    act(() => { renderer = create(<StreamingMessage
      app={{} as any}
      message={{
        role: "assistant", content: "", streaming: true,
        permissionRequests: [
          { requestId: "a1", toolName: "command", availableDecisions: ["allow"] },
          { requestId: "a2", toolName: "file change", availableDecisions: ["deny"] },
        ],
        askQuestions: [
          { id: "q1", questions: [{ id: "one", question: "One?" }], answers: {} },
          { id: "q2", questions: [{ id: "two", question: "Two?" }], answers: {} },
        ],
      }}
      onPermissionResponse={vi.fn()}
      onQuestionAnswer={vi.fn()}
    />); });
    expect(renderer!.root.findAllByType(PermissionRequest)).toHaveLength(2);
    expect(renderer!.root.findAllByType(AskQuestion)).toHaveLength(2);
  });

  it("keeps a pending approval visible after a turn completes with text", () => {
    act(() => { renderer = create(<ChatMessage
      app={{} as any}
      message={{ role: "assistant", content: "Finished text", streaming: false, permissionRequests: [
        { requestId: "late", toolName: "command", availableDecisions: ["deny"] },
      ] }}
      onPermissionResponse={vi.fn()}
    />); });
    expect(renderer!.root.findAllByType(PermissionRequest)).toHaveLength(1);
  });
});
