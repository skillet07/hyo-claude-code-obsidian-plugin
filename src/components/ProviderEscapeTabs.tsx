import React from "react";
import type { TabSession } from "../hooks/useSessionManager";
import type { ProviderId } from "../providers/types";

interface ProviderEscapeTabsProps {
  tabs: TabSession[];
  activeTabId: string;
  providerHealthy: Record<ProviderId, boolean>;
  onSwitch(tabId: string): void;
}

export function ProviderEscapeTabs({
  tabs,
  activeTabId,
  providerHealthy,
  onSwitch,
}: ProviderEscapeTabsProps) {
  const escapeTabs = tabs.filter((tab) =>
    tab.id !== activeTabId && providerHealthy[tab.providerId]);
  if (escapeTabs.length === 0) return null;
  return (
    <div className="hyo-provider-escape">
      <p>Return to an available chat:</p>
      {escapeTabs.map((tab) => (
        <button
          key={tab.id}
          className="hyo-provider-escape-tab"
          onClick={() => onSwitch(tab.id)}
        >
          {tab.providerId === "codex" ? "Codex" : "Claude"} · {tab.title}
        </button>
      ))}
    </div>
  );
}
