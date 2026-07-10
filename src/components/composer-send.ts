export function clearComposerAfterAcceptedSend(
  accepted: boolean,
  clear: () => void,
): void {
  if (accepted) clear();
}

export function prepareProviderMessage(options: {
  providerId: "claude" | "codex";
  text: string;
  pdfs: Array<{ name: string; mediaType?: string; data?: string }>;
  skills: Array<{ name: string; path?: string }>;
  writeBinary: (name: string, bytes: Uint8Array) => string;
}): string | unknown[] {
  const blocks: any[] = [];
  let remainingText = options.text;
  if (options.providerId === "codex") {
    const match = remainingText.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    const skill = match && options.skills.find((candidate) => candidate.name === match[1] && candidate.path);
    if (skill?.path) {
      blocks.push({ type: "skill", name: skill.name, path: skill.path });
      remainingText = match?.[2] ?? "";
    }
  }
  if (remainingText) blocks.push({ type: "text", text: remainingText });
  for (const pdf of options.pdfs) {
    if (options.providerId === "codex") {
      if (!pdf.data) throw new Error(`PDF "${pdf.name}" has no data`);
      const path = options.writeBinary(pdf.name, Buffer.from(pdf.data, "base64"));
      blocks.push({ type: "document", source: { type: "file", path } });
    } else {
      blocks.push({ type: "document", source: { type: "base64", media_type: pdf.mediaType, data: pdf.data } });
    }
  }
  if (blocks.length === 1 && blocks[0].type === "text" && options.pdfs.length === 0) return remainingText;
  return blocks;
}
