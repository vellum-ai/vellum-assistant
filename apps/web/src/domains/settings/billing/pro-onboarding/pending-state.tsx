import { Loader2 } from "lucide-react";

import { Typography } from "@vellumai/design-library/components/typography";

export function PendingState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <div className="relative flex h-11 w-11 items-center justify-center">
        <div
          className="absolute h-14 w-14 rounded-full"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--system-positive-strong) 10%, transparent)",
            animation: "onboarding-glow 2.4s ease-in-out infinite",
          }}
          aria-hidden="true"
        />
        <div
          className="absolute h-9 w-9 rounded-full"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--system-positive-strong) 8%, transparent)",
            animation: "onboarding-glow 2.4s ease-in-out infinite 0.4s",
          }}
          aria-hidden="true"
        />
        <Loader2
          className="relative h-5 w-5 animate-spin text-[var(--system-positive-strong)]"
          aria-hidden="true"
        />
      </div>
      <div className="space-y-1.5">
        <Typography variant="title-small" as="h1">
          {title}
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          {body}
        </Typography>
      </div>
    </div>
  );
}
