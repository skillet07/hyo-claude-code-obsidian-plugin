import { describe, expect, it } from "vitest";
import {
  convertProviderInput,
  UnsupportedCodexInputError,
} from "./input-converter";

describe("convertProviderInput", () => {
  it("converts text to generated Codex text input", () => {
    expect(convertProviderInput("hello")).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  it("converts Claude base64 and data URL images", () => {
    expect(convertProviderInput([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
      { type: "image", url: "data:image/jpeg;base64,aW1hZ2U=" },
    ])).toEqual([
      { type: "image", url: "data:image/png;base64,aGVsbG8=" },
      { type: "image", url: "data:image/jpeg;base64,aW1hZ2U=" },
    ]);
  });

  it("converts local image path references to localImage", () => {
    expect(convertProviderInput([
      { type: "image", source: { type: "file", path: "/tmp/image.png" } },
      { type: "localImage", path: "/tmp/other.jpg" },
    ])).toEqual([
      { type: "localImage", path: "/tmp/image.png" },
      { type: "localImage", path: "/tmp/other.jpg" },
    ]);
  });

  it("converts document path references to explicit text context", () => {
    expect(convertProviderInput([
      { type: "document", source: { type: "file", path: "/tmp/report.pdf" } },
    ])).toEqual([{
      type: "text",
      text: "[Document path: /tmp/report.pdf] Use file tools to read this document.",
      text_elements: [],
    }]);
  });

  it("rejects base64 documents with an actionable error", () => {
    expect(() => convertProviderInput([{
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
    }])).toThrow(UnsupportedCodexInputError);
    expect(() => convertProviderInput([{
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
    }])).toThrow(/save the PDF to disk/i);
  });
});
