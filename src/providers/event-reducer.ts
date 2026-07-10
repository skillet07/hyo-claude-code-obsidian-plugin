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
