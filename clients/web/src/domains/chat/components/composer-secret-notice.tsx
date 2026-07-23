import { Notice } from "@vellumai/design-library";
import type { DetectedSecret } from "@vellumai/service-contracts/secret-detection";

/** Leading characters of the detected value kept visible in the masked preview. */
const MASK_VISIBLE_CHARS = 6;
const MASK_BULLETS = "•".repeat(8);

/**
 * Masked preview of a detected secret: a short recognizable head plus a
 * fixed bullet tail — never the full value.
 */
export function maskSecretValue(value: string): string {
  return `${value.slice(0, MASK_VISIBLE_CHARS)}${MASK_BULLETS}`;
}

export interface ComposerSecretNoticeProps {
  /** Detected secrets ordered by draft position; the first is previewed. */
  matches: DetectedSecret[];
  /** Invoked when the user dismisses the warning. */
  onDismiss: () => void;
}

/**
 * Passive warning above the composer when the draft contains what looks
 * like an API key. The copy is deliberately generic — the detection label
 * (which names the vendor) stays internal and is never rendered. The
 * detected value appears masked only; the full plaintext never reaches the
 * DOM.
 */
export function ComposerSecretNotice({
  matches,
  onDismiss,
}: ComposerSecretNoticeProps) {
  const first = matches[0];
  if (!first) {
    return null;
  }
  return (
    <div className="mb-2">
      <Notice
        tone="warning"
        title="This looks like an API key"
        onDismiss={onDismiss}
      >
        <span className="font-mono">{maskSecretValue(first.value)}</span>
        <p>
          Credentials sent in chat are visible in the transcript — store it
          securely instead.
        </p>
      </Notice>
    </div>
  );
}
