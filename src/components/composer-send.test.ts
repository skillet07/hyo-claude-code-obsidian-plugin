import { describe, expect, it, vi } from "vitest";
import { clearComposerAfterAcceptedSend, prepareProviderMessage } from "./composer-send";

describe("clearComposerAfterAcceptedSend", () => {
  it("preserves the composer when a send is rejected", () => {
    const clear = vi.fn();

    clearComposerAfterAcceptedSend(false, clear);

    expect(clear).not.toHaveBeenCalled();
  });

  it("clears the composer when a send is accepted", () => {
    const clear = vi.fn();

    clearComposerAfterAcceptedSend(true, clear);

    expect(clear).toHaveBeenCalledOnce();
  });
});

describe("prepareProviderMessage", () => {
  it("persists Codex PDFs byte-for-byte and emits a local document path", () => {
    const writeBinary = vi.fn(() => "/attachments/report.pdf");
    const result = prepareProviderMessage({
      providerId: "codex", text: "inspect", pdfs: [{ name: "report.pdf", mediaType: "application/pdf", data: "AAH+/w==" }],
      skills: [], writeBinary,
    });
    expect(writeBinary).toHaveBeenCalledWith("report.pdf", Buffer.from([0, 1, 254, 255]));
    expect(result).toEqual([
      { type: "text", text: "inspect" },
      { type: "document", source: { type: "file", path: "/attachments/report.pdf" } },
    ]);
  });

  it("keeps Claude PDFs inline and structures matching Codex slash skills", () => {
    const pdf = { name: "report.pdf", mediaType: "application/pdf", data: "JVBERg==" };
    expect(prepareProviderMessage({ providerId: "claude", text: "hello", pdfs: [pdf], skills: [], writeBinary: vi.fn() }))
      .toContainEqual({ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" } });
    expect(prepareProviderMessage({
      providerId: "codex", text: "/review focus here", pdfs: [],
      skills: [{ name: "review", path: "/skills/review/SKILL.md" }], writeBinary: vi.fn(),
    })).toEqual([
      { type: "skill", name: "review", path: "/skills/review/SKILL.md" },
      { type: "text", text: "focus here" },
    ]);
  });

  it("throws before acceptance when Codex PDF persistence fails", () => {
    const clear = vi.fn();
    expect(() => prepareProviderMessage({
      providerId: "codex", text: "inspect", pdfs: [{ name: "report.pdf", data: "JVBERg==" }], skills: [],
      writeBinary: () => { throw new Error("read-only directory"); },
    })).toThrow("read-only directory");
    clearComposerAfterAcceptedSend(false, clear);
    expect(clear).not.toHaveBeenCalled();
  });
});
