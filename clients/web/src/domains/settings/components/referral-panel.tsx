import { Card } from "@vellumai/design-library/components/card";

import { ReferralContent } from "./referral-content";

const REFERRAL_PANEL_ANCHOR_ID = "settings-referral-panel";

export function ReferralPanel() {
  return (
    <Card padding="md" id={REFERRAL_PANEL_ANCHOR_ID}>
      <ReferralContent />
    </Card>
  );
}
