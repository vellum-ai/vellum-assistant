import { AlertCircle } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

import { IconBadge } from "./primitives";

export function FetchErrorState({ onGoToBilling }: { onGoToBilling: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
      <IconBadge icon={AlertCircle} tone="negative" />
      <div className="space-y-1.5">
        <Typography variant="title-small" as="h1">
          Couldn&apos;t reach billing
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          We hit a problem checking your subscription. Your upgrade may still be
          processing — return to billing to refresh.
        </Typography>
      </div>
      <Button
        variant="primary"
        data-testid="onboarding-go-to-billing"
        onClick={onGoToBilling}
      >
        Go to billing
      </Button>
    </div>
  );
}

export function TimeoutState({
  message,
  onRetry,
  onGoToBilling,
}: {
  message: string;
  onRetry: () => void;
  onGoToBilling: () => void;
}) {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
      <IconBadge icon={AlertCircle} tone="warning" />
      <div className="space-y-1.5">
        <Typography variant="title-small" as="h1">
          Taking longer than expected
        </Typography>
        <Typography
          variant="body-medium-lighter"
          as="p"
          className="text-[var(--content-secondary)]"
        >
          {message}
        </Typography>
      </div>
      <div className="flex items-center gap-2 pt-2">
        <Button
          variant="outlined"
          data-testid="onboarding-go-to-billing"
          onClick={onGoToBilling}
        >
          Go to billing
        </Button>
        <Button
          variant="primary"
          data-testid="onboarding-retry"
          onClick={onRetry}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
