import type { OrderedBlock } from "../chat-types";

export function applyProviderTextDelta(
  blocks: OrderedBlock[],
  turnIndex: number,
  itemId: string | undefined,
  delta: string,
): void {
  const existing = findTextBlock(blocks, turnIndex, itemId);
  if (existing) {
    existing.content = (existing.content ?? "") + delta;
    return;
  }
  blocks.push({
    type: "text",
    content: delta,
    turnIndex,
    ...(itemId ? { providerItemId: itemId } : {}),
  });
}

export function applyAgentMessageCompletion(
  blocks: OrderedBlock[],
  turnIndex: number,
  itemId: string,
  text: string,
): void {
  const existing = findTextBlock(blocks, turnIndex, itemId);
  if (existing) {
    existing.content = text;
    return;
  }
  blocks.push({
    type: "text",
    content: text,
    turnIndex,
    providerItemId: itemId,
  });
}

export function applyPlanDelta(
  blocks: OrderedBlock[], turnIndex: number, itemId: string, delta: string,
): void {
  const id = `plan:${itemId || "current"}`;
  const existing = blocks.find((block) => block.providerItemId === id)
    ?? [...blocks].reverse().find((block) => block.providerItemId === "plan:current");
  if (existing) {
    existing.content = `${existing.content ?? ""}${delta}`;
    existing.providerItemId = id;
  }
  else blocks.push({ type: "text", content: `### Plan\n\n${delta}`, turnIndex, providerItemId: id });
}

export function applyPlanUpdate(
  blocks: OrderedBlock[],
  turnIndex: number,
  event: { itemId?: string; text?: string; explanation?: string | null; steps?: Array<{ step: string; status: string }>; final: boolean },
): void {
  const id = `plan:${event.itemId || "current"}`;
  const body = event.text ?? [
    event.explanation,
    ...(event.steps ?? []).map((step) => `- ${planStatus(step.status)} ${step.step}`),
  ].filter(Boolean).join("\n\n");
  const content = `### Plan${event.final ? "" : " (updated)"}\n\n${body}`;
  let existing = blocks.find((block) => block.providerItemId === id);
  if (!existing) existing = [...blocks].reverse().find((block) => block.providerItemId?.startsWith("plan:"));
  if (existing) {
    existing.content = content;
    existing.providerItemId = id;
  }
  else blocks.push({ type: "text", content, turnIndex, providerItemId: id });
}

export function applyReasoningCompletion(
  blocks: OrderedBlock[], turnIndex: number, itemId: string, summary: string[], content: string[],
): void {
  const finalContent = (summary.length ? summary : content).join("\n\n");
  const existing = blocks.find((block) => block.type === "thinking" && block.providerItemId === itemId)
    ?? [...blocks].reverse().find((block) =>
      block.type === "thinking" && block.turnIndex === turnIndex && block.providerItemId === undefined,
    );
  if (existing) {
    existing.content = finalContent;
    existing.providerItemId = itemId;
  } else blocks.push({ type: "thinking", content: finalContent, turnIndex, providerItemId: itemId });
}

function planStatus(status: string): string {
  return status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
}

function findTextBlock(
  blocks: OrderedBlock[],
  turnIndex: number,
  itemId: string | undefined,
): OrderedBlock | undefined {
  return blocks.find((block) =>
    block.type === "text" &&
    (itemId
      ? block.providerItemId === itemId
      : block.providerItemId === undefined && block.turnIndex === turnIndex),
  );
}
