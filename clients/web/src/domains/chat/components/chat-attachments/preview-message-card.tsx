import { Download } from "lucide-react";

import { Button } from "@vellumai/design-library";

interface PreviewMessageCardProps {
  message: string;
  filename: string;
  onDownload: () => void;
  /** Disable the download affordance when there is no fetchable URL yet. */
  downloadDisabled?: boolean;
}

/**
 * Centered "can't show it inline — here's a download" card used by the
 * attachment preview modal and its text preview (load failure, file too large,
 * unsupported type). White tints are intentional and theme-independent: this
 * always renders on the modal's fixed `bg-black/80` backdrop, so design-token
 * surfaces aren't needed for legibility.
 */
export function PreviewMessageCard({
  message,
  filename,
  onDownload,
  downloadDisabled = false,
}: PreviewMessageCardProps) {
  return (
    <div className="w-full max-w-sm rounded-lg border border-white/15 bg-white/[0.08] p-8 text-center">
      <p className="text-body-medium-lighter text-white/80">{message}</p>
      <Button
        variant="ghost"
        leftIcon={<Download />}
        onClick={onDownload}
        disabled={downloadDisabled}
        aria-label={`Download ${filename}`}
        className="mt-4 text-white/70 hover:bg-white/10 hover:text-white max-md:bg-transparent"
        tintColor="currentColor"
      >
        Download
      </Button>
    </div>
  );
}
