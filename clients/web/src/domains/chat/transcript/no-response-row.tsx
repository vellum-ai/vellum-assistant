import { useTranslation } from "@/i18n";

/**
 * Quiet standalone marker for a turn whose whole reply was deliberate
 * silence (flagged `isNoResponse`: the assistant output the no-response
 * sentinel as its entire reply). Renders fixed copy rather than the row's
 * content, which is the raw sentinel kept for the model's own history.
 * The row's presence is what resolves the pending-response state, so
 * silence reads as a decision instead of a reply that never arrives.
 */
export function NoResponseRow() {
  const { t } = useTranslation("chat");
  return (
    <div data-testid="no-response-row" className="flex justify-center">
      <div className="text-body-small-default text-[var(--content-tertiary)] italic">
        {t("transcript.noResponse")}
      </div>
    </div>
  );
}
