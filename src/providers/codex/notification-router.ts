import type { ProviderEvent } from "../types";
import type { ServerNotification } from "./generated/ServerNotification";
import { CodexEventNormalizer } from "./event-normalizer";

export interface CodexRuntimeRegistration {
  runtimeId: string;
  threadId: string;
  onEvent: (event: ProviderEvent) => void;
}

interface BufferedEvents {
  sequence: number;
  threadId: string;
  turnId: string;
  itemId: string;
  events: ProviderEvent[];
}

type BoundaryNotification = ServerNotification | { method: string; params?: unknown };

export class CodexNotificationRouter {
  private readonly runtimes = new Map<string, CodexRuntimeRegistration>();
  private readonly turnOwners = new Map<string, string>();
  private readonly bufferedByItem = new Map<string, BufferedEvents[]>();
  private sequence = 0;

  constructor(private readonly normalizer = new CodexEventNormalizer()) {}

  registerRuntime(registration: CodexRuntimeRegistration): void {
    this.unregisterRuntime(registration.runtimeId);
    this.runtimes.set(registration.runtimeId, registration);
  }

  unregisterRuntime(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId);
    this.runtimes.delete(runtimeId);
    for (const [key, owner] of this.turnOwners) {
      if (owner === runtimeId) this.turnOwners.delete(key);
    }
    if (runtime && ![...this.runtimes.values()].some((candidate) => candidate.threadId === runtime.threadId)) {
      for (const [key, queue] of this.bufferedByItem) {
        const keep = queue.filter((entry) => entry.threadId !== runtime.threadId);
        if (keep.length === 0) this.bufferedByItem.delete(key);
        else this.bufferedByItem.set(key, keep);
      }
    }
  }

  bindTurn(runtimeId: string, turnId: string): void {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Unknown Codex runtime: ${runtimeId}`);
    const turnKey = makeTurnKey(runtime.threadId, turnId);
    const existingOwner = this.turnOwners.get(turnKey);
    if (existingOwner && existingOwner !== runtimeId) {
      throw new Error(`Codex turn ${turnId} in thread ${runtime.threadId} is already bound`);
    }
    this.turnOwners.set(turnKey, runtimeId);
    this.flush(runtime, turnId);
  }

  route(notification: BoundaryNotification): void {
    const events = this.normalizer.normalize(notification);
    if (events.length === 0) return;
    const identity = getIdentity(notification.params);

    if (!identity.threadId) {
      for (const runtime of this.runtimes.values()) this.emit(runtime, events);
      return;
    }

    if (!identity.turnId) {
      for (const runtime of this.runtimes.values()) {
        if (runtime.threadId === identity.threadId) this.emit(runtime, events);
      }
      return;
    }

    const ownerId = this.turnOwners.get(makeTurnKey(identity.threadId, identity.turnId));
    const owner = ownerId ? this.runtimes.get(ownerId) : undefined;
    if (owner) {
      this.emit(owner, events);
      return;
    }

    if (![...this.runtimes.values()].some((runtime) => runtime.threadId === identity.threadId)) {
      return;
    }

    const itemKey = makeItemKey(identity.threadId, identity.turnId, identity.itemId);
    const queue = this.bufferedByItem.get(itemKey) ?? [];
    queue.push({ sequence: this.sequence++, ...identity, events });
    this.bufferedByItem.set(itemKey, queue);
  }

  getBufferedCount(threadId: string, turnId: string): number {
    let count = 0;
    for (const queue of this.bufferedByItem.values()) {
      count += queue.filter((entry) => entry.threadId === threadId && entry.turnId === turnId).length;
    }
    return count;
  }

  private flush(runtime: CodexRuntimeRegistration, turnId: string): void {
    const pending: BufferedEvents[] = [];
    for (const [key, queue] of this.bufferedByItem) {
      const keep: BufferedEvents[] = [];
      for (const entry of queue) {
        if (entry.threadId === runtime.threadId && entry.turnId === turnId) pending.push(entry);
        else keep.push(entry);
      }
      if (keep.length === 0) this.bufferedByItem.delete(key);
      else this.bufferedByItem.set(key, keep);
    }
    pending.sort((left, right) => left.sequence - right.sequence);
    for (const entry of pending) this.emit(runtime, entry.events);
  }

  private emit(runtime: CodexRuntimeRegistration, events: ProviderEvent[]): void {
    for (const event of events) runtime.onEvent(event);
  }
}

function getIdentity(params: unknown): { threadId: string; turnId: string; itemId: string } {
  if (!isRecord(params)) return { threadId: "", turnId: "", itemId: "" };
  const item = isRecord(params.item) ? params.item : undefined;
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return {
    threadId: typeof params.threadId === "string" ? params.threadId : "",
    turnId: typeof params.turnId === "string"
      ? params.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : "",
    itemId: typeof params.itemId === "string"
      ? params.itemId
      : typeof item?.id === "string"
        ? item.id
        : "",
  };
}

function makeTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function makeItemKey(threadId: string, turnId: string, itemId: string): string {
  return `${makeTurnKey(threadId, turnId)}\u0000${itemId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
