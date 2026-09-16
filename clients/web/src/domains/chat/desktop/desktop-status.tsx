import { Typography } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

interface DesktopStatusProps {
  message: string;
  loading?: boolean;
  children?: ReactNode;
}

export function DesktopStatus({ message, loading, children }: DesktopStatusProps) {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-[var(--content-default)]"
      role="status"
      aria-live="polite"
    >
      {loading && (
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[var(--content-tertiary)]" />
      )}
      <Typography as="p" variant="body-medium-lighter">
        {message}
      </Typography>
      {children}
    </div>
  );
}
