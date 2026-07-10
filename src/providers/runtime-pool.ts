export interface RuntimePoolHandle {
  cleanup(): void;
  unregister(): void;
}

interface RuntimeEntry {
  cleanup: () => void;
}

export class RuntimePool<Runtime extends object> {
  private readonly entries = new Map<Runtime, RuntimeEntry>();

  get size(): number {
    return this.entries.size;
  }

  register(runtime: Runtime, cleanup: () => void): RuntimePoolHandle {
    this.entries.set(runtime, { cleanup });
    return {
      cleanup: () => this.cleanup(runtime),
      unregister: () => {
        this.entries.delete(runtime);
      },
    };
  }

  cleanupAll(): void {
    for (const runtime of [...this.entries.keys()]) this.cleanup(runtime);
  }

  private cleanup(runtime: Runtime): void {
    const entry = this.entries.get(runtime);
    if (!entry) return;
    this.entries.delete(runtime);
    entry.cleanup();
  }
}
