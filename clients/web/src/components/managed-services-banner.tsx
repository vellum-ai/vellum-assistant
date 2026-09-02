import type { PropsWithChildren } from "react";

import { ExternalLink, Info } from "lucide-react";

import { Trans } from "@/i18n";

function ManagedServicesPricingLink({ children }: PropsWithChildren) {
  return (
    <a
      href="https://www.vellum.ai/docs/pricing"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[var(--primary-base)] hover:underline"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function ManagedServicesBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] px-4 py-2.5">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
      <p className="text-body-medium-lighter text-[var(--content-secondary)]">
        <Trans
          i18nKey="managedServicesBanner.body"
          ns="common"
          components={{ link: <ManagedServicesPricingLink /> }}
        />
      </p>
    </div>
  );
}
