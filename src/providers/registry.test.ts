import { describe, expect, it } from "vitest";
import type { ChatProvider } from "./types";
import { ProviderRegistry } from "./registry";

function provider(id: ChatProvider["id"]): ChatProvider {
  return { id } as ChatProvider;
}

describe("ProviderRegistry", () => {
  it("resolves a registered provider by id", () => {
    const claude = provider("claude");
    const registry = new ProviderRegistry([claude]);

    expect(registry.resolve("claude")).toBe(claude);
  });

  it("fails clearly when a provider is not registered", () => {
    const registry = new ProviderRegistry([provider("claude")]);

    expect(() => registry.resolve("codex")).toThrowError(
      'Provider "codex" is not registered',
    );
  });

  it("rejects duplicate provider registrations", () => {
    const registry = new ProviderRegistry([provider("claude")]);

    expect(() => registry.register(provider("claude"))).toThrowError(
      'Provider "claude" is already registered',
    );
  });
});
