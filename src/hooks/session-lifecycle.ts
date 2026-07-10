export interface SessionRuntime {
  cleanup(): void;
}

export interface RuntimeLease {
  readonly tabId: string;
  readonly generation: number;
}

interface RuntimeEntry<Runtime extends SessionRuntime> {
  runtime: Runtime;
  lease: RuntimeLease;
}

export class SessionLifecycle<Runtime extends SessionRuntime> {
  private readonly runtimes = new Map<string, RuntimeEntry<Runtime>>();
  private readonly busyTabs = new Set<string>();
  private generation = 0;

  attachRuntime(tabId: string, runtime: Runtime): RuntimeLease {
    const previous = this.runtimes.get(tabId);
    this.runtimes.delete(tabId);
    previous?.runtime.cleanup();
    const lease = { tabId, generation: ++this.generation };
    this.runtimes.set(tabId, { runtime, lease });
    return lease;
  }

  getRuntime(tabId: string): Runtime | undefined {
    return this.runtimes.get(tabId)?.runtime;
  }

  ownsRuntime(lease: RuntimeLease): boolean {
    return this.runtimes.get(lease.tabId)?.lease.generation === lease.generation;
  }

  releaseRuntime(lease: RuntimeLease): boolean {
    if (!this.ownsRuntime(lease)) return false;
    this.runtimes.delete(lease.tabId);
    this.finishTurn(lease.tabId);
    return true;
  }

  cleanupRuntime(tabId: string): void {
    const entry = this.runtimes.get(tabId);
    this.runtimes.delete(tabId);
    this.finishTurn(tabId);
    entry?.runtime.cleanup();
  }

  detachAll(): string[] {
    const tabIds = [...this.runtimes.keys()];
    this.runtimes.clear();
    this.busyTabs.clear();
    return tabIds;
  }

  detachWhere(predicate: (runtime: Runtime) => boolean): string[] {
    const tabIds: string[] = [];
    for (const [tabId, entry] of this.runtimes) {
      if (!predicate(entry.runtime)) continue;
      this.runtimes.delete(tabId);
      this.busyTabs.delete(tabId);
      tabIds.push(tabId);
    }
    return tabIds;
  }

  beginTurn(tabId: string): boolean {
    if (this.busyTabs.has(tabId)) return false;
    this.busyTabs.add(tabId);
    return true;
  }

  finishTurn(tabId: string): void {
    this.busyTabs.delete(tabId);
  }
}
