import React from "react";
import type { ProviderOnboarding } from "../provider-onboarding";

interface ProviderInstallLinkProps {
  onboarding: ProviderOnboarding;
}

export function ProviderInstallLink({ onboarding }: ProviderInstallLinkProps) {
  return (
    <a href={onboarding.installUrl} target="_blank" rel="noopener">
      Official {onboarding.providerName} installation guide →
    </a>
  );
}
