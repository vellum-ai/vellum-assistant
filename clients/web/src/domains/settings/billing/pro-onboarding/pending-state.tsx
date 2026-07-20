import { Typography } from "@vellumai/design-library/components/typography";

import { GlowSpinner } from "./primitives";

export function PendingState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <GlowSpinner />
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
