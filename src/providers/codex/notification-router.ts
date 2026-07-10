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
  expiresAt: number;
  retireAfterDelivery: boolean;
}

type BoundaryNotification = ServerNotification | { method: string; params?: unknown };

export const CODEX_ROUTER_DEFAULTS = {
  maxBufferedPerItem: 64,
  maxBufferedTotal: 1024,
  bufferTtlMs: 30_000,
  retiredTurnTtlMs: 30_000,
} as const;

export interface CodexNotificationRouterOptions {
  maxBufferedPerItem?: number;
  maxBufferedTotal?: number;
  bufferTtlMs?: number;
  retiredTurnTtlMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  onUnknownNotification?: (method: string) => void;
  maxUnknownDiagnostics?: number;
}

export class CodexNotificationRouter {
  private readonly runtimes = new Map<string, CodexRuntimeRegistration>();
  private readonly turnOwners = new Map<string, string>();
  private readonly bufferedByItem = new Map<string, BufferedEvents[]>();
  private readonly retiredTurns = new Map<string, number>();
  private readonly tombstoneTimers = new Map<string, unknown>();
  private readonly options: Required<Omit<CodexNotificationRouterOptions, "onUnknownNotification" | "maxUnknownDiagnostics">>;
  private readonly unknownMethods = new Set<string>();
  private readonly onUnknownNotification?: (method: string) => void;
  private readonly maxUnknownDiagnostics: number;
  private readonly normalizer: CodexEventNormalizer;
  private bufferedTotal = 0;
  private expiryTimer: unknown;
  private sequence = 0;

  constructor(
    normalizer: CodexEventNormalizer | undefined = undefined,
    options: CodexNotificationRouterOptions = {},
  ) {
    const { onUnknownNotification, maxUnknownDiagnostics = 20, ...routingOptions } = options;
    this.onUnknownNotification = onUnknownNotification;
    this.maxUnknownDiagnostics = maxUnknownDiagnostics;
    this.normalizer = normalizer ?? new CodexEventNormalizer({
      onUnknownNotification: ({ method }) => this.reportUnknown(method),
    });
    this.options = {
      ...CODEX_ROUTER_DEFAULTS,
      now: () => Date.now(),
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      ...routingOptions,
    };
  }

  private reportUnknown(method: string): void {
    if (this.unknownMethods.has(method) || this.unknownMethods.size >= this.maxUnknownDiagnostics) return;
    this.unknownMethods.add(method);
    try { this.onUnknownNotification?.(method); } catch { /* diagnostics are non-fatal */ }
  }

  registerRuntime(registration: CodexRuntimeRegistration): void {
    this.unregisterRuntime(registration.runtimeId);
    this.runtimes.set(registration.runtimeId, registration);
  }

  unregisterRuntime(runtimeId: string): void {
    const runtime = this.runtimes.get(runtimeId);
    this.runtimes.delete(runtimeId);
    for (const [key, owner] of this.turnOwners) {
      if (owner === runtimeId) {
        this.turnOwners.delete(key);
      }
    }
    if (runtime && ![...this.runtimes.values()].some((candidate) => candidate.threadId === runtime.threadId)) {
      this.dropBuffers((entry) => entry.threadId === runtime.threadId);
      const prefix = `${runtime.threadId}\u0000`;
      for (const key of [...this.retiredTurns.keys()]) {
        if (key.startsWith(prefix)) this.clearRetiredTurn(key);
      }
    }
  }

  bindTurn(runtimeId: string, turnId: string): boolean {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error(`Unknown Codex runtime: ${runtimeId}`);
    const turnKey = makeTurnKey(runtime.threadId, turnId);
    if (this.retiredTurns.has(turnKey)) return false;
    const existingOwner = this.turnOwners.get(turnKey);
    if (existingOwner && existingOwner !== runtimeId) {
      throw new Error(`Codex turn ${turnId} in thread ${runtime.threadId} is already bound`);
    }
    this.turnOwners.set(turnKey, runtimeId);
    this.flush(runtime, turnId);
    return true;
  }

  retireTurn(runtimeId: string, turnId: string): boolean {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return false;
    const turnKey = makeTurnKey(runtime.threadId, turnId);
    if (this.turnOwners.get(turnKey) !== runtimeId) return false;
    this.retireTurnKey(turnKey);
    return true;
  }

  getOwnedTurnCount(): number {
    return this.turnOwners.size;
  }

  getRetiredTurnCount(): number {
    return this.retiredTurns.size;
  }

  route(notification: BoundaryNotification): void {
    this.pruneExpiredBuffers();
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

    const turnKey = makeTurnKey(identity.threadId, identity.turnId);
    if (this.retiredTurns.has(turnKey)) return;

    const ownerId = this.turnOwners.get(turnKey);
    const owner = ownerId ? this.runtimes.get(ownerId) : undefined;
    if (owner) {
      this.emit(owner, events);
      if (notification.method === "turn/completed") {
        this.retireTurnKey(turnKey);
      }
      return;
    }

    if (![...this.runtimes.values()].some((runtime) => runtime.threadId === identity.threadId)) {
      return;
    }

    this.buffer({
      sequence: this.sequence++,
      ...identity,
      events,
      expiresAt: this.options.now() + this.options.bufferTtlMs,
      retireAfterDelivery: notification.method === "turn/completed",
    });
  }

  getBufferedCount(threadId: string, turnId: string): number {
    this.pruneExpiredBuffers();
    let count = 0;
    for (const queue of this.bufferedByItem.values()) {
      count += queue.filter((entry) => entry.threadId === threadId && entry.turnId === turnId).length;
    }
    return count;
  }

  dispose(): void {
    if (this.expiryTimer !== undefined) this.options.clearTimer(this.expiryTimer);
    for (const timer of this.tombstoneTimers.values()) this.options.clearTimer(timer);
    this.expiryTimer = undefined;
    this.tombstoneTimers.clear();
    this.turnOwners.clear();
    this.retiredTurns.clear();
    this.bufferedByItem.clear();
    this.bufferedTotal = 0;
  }

  private flush(runtime: CodexRuntimeRegistration, turnId: string): void {
    this.pruneExpiredBuffers();
    const pending: BufferedEvents[] = [];
    for (const [key, queue] of this.bufferedByItem) {
      const keep: BufferedEvents[] = [];
      for (const entry of queue) {
        if (entry.threadId === runtime.threadId && entry.turnId === turnId) {
          pending.push(entry);
          this.bufferedTotal--;
        }
        else keep.push(entry);
      }
      if (keep.length === 0) this.bufferedByItem.delete(key);
      else this.bufferedByItem.set(key, keep);
    }
    pending.sort((left, right) => left.sequence - right.sequence);
    const turnKey = makeTurnKey(runtime.threadId, turnId);
    for (const entry of pending) {
      this.emit(runtime, entry.events);
      if (entry.retireAfterDelivery) {
        this.retireTurnKey(turnKey);
        break;
      }
    }
    this.scheduleExpiry();
  }

  private emit(runtime: CodexRuntimeRegistration, events: ProviderEvent[]): void {
    for (const event of events) runtime.onEvent(event);
  }

  private buffer(entry: BufferedEvents): void {
    if (this.options.maxBufferedPerItem <= 0 || this.options.maxBufferedTotal <= 0) return;
    const itemKey = makeItemKey(entry.threadId, entry.turnId, entry.itemId);
    const queue = this.bufferedByItem.get(itemKey) ?? [];
    while (queue.length >= this.options.maxBufferedPerItem) {
      queue.shift();
      this.bufferedTotal--;
    }
    while (this.bufferedTotal >= this.options.maxBufferedTotal) this.evictOldestBuffer();
    queue.push(entry);
    this.bufferedTotal++;
    this.bufferedByItem.set(itemKey, queue);
    this.scheduleExpiry();
  }

  private evictOldestBuffer(): void {
    let oldestKey: string | undefined;
    let oldestSequence = Number.POSITIVE_INFINITY;
    for (const [key, queue] of this.bufferedByItem) {
      if (queue[0] && queue[0].sequence < oldestSequence) {
        oldestKey = key;
        oldestSequence = queue[0].sequence;
      }
    }
    if (!oldestKey) return;
    const queue = this.bufferedByItem.get(oldestKey)!;
    queue.shift();
    this.bufferedTotal--;
    if (queue.length === 0) this.bufferedByItem.delete(oldestKey);
  }

  private pruneExpiredBuffers(): void {
    const now = this.options.now();
    this.dropBuffers((entry) => entry.expiresAt <= now);
  }

  private dropBuffers(predicate: (entry: BufferedEvents) => boolean): void {
    for (const [key, queue] of this.bufferedByItem) {
      const keep = queue.filter((entry) => {
        if (!predicate(entry)) return true;
        this.bufferedTotal--;
        return false;
      });
      if (keep.length === 0) this.bufferedByItem.delete(key);
      else this.bufferedByItem.set(key, keep);
    }
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== undefined) {
      this.options.clearTimer(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const queue of this.bufferedByItem.values()) {
      for (const entry of queue) nearest = Math.min(nearest, entry.expiresAt);
    }
    if (!Number.isFinite(nearest)) return;
    this.expiryTimer = this.options.setTimer(() => {
      this.expiryTimer = undefined;
      this.pruneExpiredBuffers();
    }, Math.max(0, nearest - this.options.now()));
  }

  private retireTurnKey(turnKey: string): void {
    if (this.retiredTurns.has(turnKey)) return;
    this.turnOwners.delete(turnKey);
    const [threadId, turnId] = splitTurnKey(turnKey);
    this.dropBuffers((entry) => entry.threadId === threadId && entry.turnId === turnId);
    this.retiredTurns.set(turnKey, this.options.now() + this.options.retiredTurnTtlMs);
    const timer = this.options.setTimer(() => {
      this.tombstoneTimers.delete(turnKey);
      this.retiredTurns.delete(turnKey);
    }, this.options.retiredTurnTtlMs);
    this.tombstoneTimers.set(turnKey, timer);
  }

  private clearRetiredTurn(turnKey: string): void {
    this.retiredTurns.delete(turnKey);
    const timer = this.tombstoneTimers.get(turnKey);
    if (timer !== undefined) this.options.clearTimer(timer);
    this.tombstoneTimers.delete(turnKey);
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

function splitTurnKey(turnKey: string): [string, string] {
  const separator = turnKey.indexOf("\u0000");
  return [turnKey.slice(0, separator), turnKey.slice(separator + 1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
