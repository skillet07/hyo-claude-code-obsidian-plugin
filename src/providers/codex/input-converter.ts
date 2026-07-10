import type { UserInput } from "./generated/v2/UserInput";

export class UnsupportedCodexInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCodexInputError";
  }
}

export function convertProviderInput(content: string | unknown[]): UserInput[] {
  if (typeof content === "string") return [textInput(content)];
  if (!Array.isArray(content)) {
    throw new UnsupportedCodexInputError(
      "Codex input must be text or an array of supported content blocks.",
    );
  }

  return content.map(convertBlock);
}

function convertBlock(value: unknown): UserInput {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new UnsupportedCodexInputError(
      "Codex received a malformed content block. Send text, an image, or a local file path.",
    );
  }

  if (value.type === "text" && typeof value.text === "string") {
    return textInput(value.text);
  }

  if (value.type === "localImage" && typeof value.path === "string") {
    return { type: "localImage", path: value.path };
  }

  if (value.type === "image") {
    if (typeof value.url === "string") {
      if (!value.url.startsWith("data:image/")) {
        throw new UnsupportedCodexInputError(
          "Codex image URLs must be data URLs. Save remote images locally and attach their path.",
        );
      }
      return { type: "image", url: value.url };
    }
    const source = isRecord(value.source) ? value.source : undefined;
    if (source?.type === "base64" && typeof source.data === "string") {
      const mediaType = typeof source.media_type === "string"
        ? source.media_type
        : "image/png";
      return { type: "image", url: `data:${mediaType};base64,${source.data}` };
    }
    if (
      (source?.type === "file" || source?.type === "path") &&
      typeof source.path === "string"
    ) {
      return { type: "localImage", path: source.path };
    }
  }

  if (value.type === "document") {
    const source = isRecord(value.source) ? value.source : undefined;
    if (
      (source?.type === "file" || source?.type === "path") &&
      typeof source.path === "string"
    ) {
      return textInput(
        `[Document path: ${source.path}] Use file tools to read this document.`,
      );
    }
    throw new UnsupportedCodexInputError(
      "Codex app-server cannot accept an inline PDF/document block. Save the PDF to disk and attach its local path instead.",
    );
  }

  throw new UnsupportedCodexInputError(
    `Codex does not support the content block type "${value.type}". Convert it to text or a local file path.`,
  );
}

function textInput(text: string): UserInput {
  return { type: "text", text, text_elements: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
