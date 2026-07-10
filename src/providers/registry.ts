import type { ChatProvider, ProviderId } from "./types";

export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, ChatProvider>();

  constructor(providers: ChatProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ChatProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  resolve(id: ProviderId): ChatProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Provider "${id}" is not registered`);
    return provider;
  }
}
