import { Check, Copy } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Button } from "@vellumai/design-library";

interface CopyButtonProps {
  text: string;
  ariaLabel: string;
  className?: string;
}

/**
 * Ghost icon button that copies `text` to the clipboard, flashing a
 * positive-tinted check while the transient copied state is active.
 */
export function CopyButton({
  text,
  ariaLabel,
  className,
}: CopyButtonProps): ReactNode {
  const { copy, copied } = useCopyToClipboard();

  return (
    <Button
      variant="ghost"
      size="compact"
      iconOnly={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      tintColor={copied ? "var(--system-positive-strong)" : undefined}
      aria-label={copied ? "Copied" : ariaLabel}
      className={className}
      onClick={() => copy(text)}
    />
  );
}
