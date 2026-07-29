import { DetailShell } from "@/components/detail-shell";
import { CallSiteOverridesContent } from "@/domains/settings/ai/call-site-overrides-content";

interface OverridesDetailPanelProps {
  assistantId: string;
  onClose: () => void;
}

/**
 * Sidepanel host for the Action Overrides editor (the Overrides section's
 * Manage action). DetailShell chrome around CallSiteOverridesContent;
 * saving or resetting closes the panel via the content's own flow.
 */
export function OverridesDetailPanel({
  assistantId,
  onClose,
}: OverridesDetailPanelProps) {
  return (
    <DetailShell
      title="Action Overrides"
      closeVariant="outlined"
      onClose={onClose}
    >
      <CallSiteOverridesContent assistantId={assistantId} onClose={onClose} />
    </DetailShell>
  );
}
