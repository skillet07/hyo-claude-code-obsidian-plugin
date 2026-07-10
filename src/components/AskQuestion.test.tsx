import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  AskQuestion,
  questionAnswerKey,
  questionRenderKey,
} from "./AskQuestion";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  renderer = undefined;
});

describe("AskQuestion", () => {
  it("submits duplicate-text questions under their distinct protocol ids", () => {
    const onAnswer = vi.fn();
    act(() => {
      renderer = create(React.createElement(AskQuestion, {
        question: {
          id: "request-1",
          questions: [
            { id: "first-id", question: "Same prompt", options: [{ label: "First" }] },
            { id: "second-id", question: "Same prompt", options: [{ label: "Second" }] },
          ],
          answers: {},
        },
        onAnswer,
      }));
    });

    act(() => {
      renderer!.root.findByProps({ className: "hyo-ask-opt" }).props.onClick();
    });
    act(() => {
      renderer!.root.findByProps({ className: "hyo-ask-opt" }).props.onClick();
    });

    expect(onAnswer).toHaveBeenCalledWith("request-1", {
      "first-id": "First",
      "second-id": "Second",
    });
  });

  it("uses a password input and never renders a secret answer", () => {
    const onAnswer = vi.fn();
    act(() => {
      renderer = create(React.createElement(AskQuestion, {
        question: {
          id: "request-secret",
          questions: [{ id: "token", question: "API token", isSecret: true }],
          answers: {},
        },
        onAnswer,
      }));
    });
    const input = renderer!.root.findByType("input");
    expect(input.props.type).toBe("password");

    act(() => input.props.onChange({ target: { value: "super-secret" } }));
    act(() => renderer!.root.findByType("input").props.onKeyDown({ key: "Enter" }));

    expect(onAnswer).toHaveBeenCalledWith("request-secret", {
      token: "super-secret",
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("super-secret");
    expect(JSON.stringify(renderer!.toJSON())).toContain("••••••");
  });

  it("keeps Claude text fallback keys unique when labels collide", () => {
    const questions = [
      { question: "Same prompt" },
      { question: "Same prompt" },
      { question: "Different prompt" },
    ];
    expect(questions.map((question, index) =>
      questionAnswerKey(question, index, questions),
    )).toEqual([
      "Same prompt",
      "Same prompt (2)",
      "Different prompt",
    ]);
  });

  it("uses neutral ids for stable render keys and disambiguates collisions", () => {
    const questions = [
      { id: "stable", question: "First" },
      { id: "stable", question: "Second" },
      { question: "Repeated" },
      { question: "Repeated" },
    ];
    expect(questions.map((question, index) =>
      questionRenderKey(question, index, questions),
    )).toEqual([
      "stable",
      "stable (2)",
      "Repeated",
      "Repeated (2)",
    ]);
  });

  it("clears local answers when a replacement request arrives", () => {
    const onAnswer = vi.fn();
    act(() => {
      renderer = create(React.createElement(AskQuestion, {
        question: {
          id: "request-old",
          questions: [
            { id: "old-1", question: "Old one", options: [{ label: "Chosen" }] },
            { id: "old-2", question: "Old two", options: [{ label: "Later" }] },
          ],
          answers: {},
        },
        onAnswer,
      }));
    });
    act(() => {
      renderer!.root.findByProps({ className: "hyo-ask-opt" }).props.onClick();
    });

    act(() => {
      renderer!.update(React.createElement(AskQuestion, {
        question: {
          id: "request-new",
          questions: [
            { id: "new-1", question: "New one", options: [{ label: "Fresh" }] },
          ],
          answers: {},
        },
        onAnswer,
      }));
    });
    act(() => {
      renderer!.root.findByProps({ className: "hyo-ask-opt" }).props.onClick();
    });

    expect(onAnswer).toHaveBeenCalledWith("request-new", { "new-1": "Fresh" });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Chosen");
  });
});
