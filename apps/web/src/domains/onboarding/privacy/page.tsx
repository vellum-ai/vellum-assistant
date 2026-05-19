import { Suspense } from "react";

import { PrivacyScreen } from "@/domains/onboarding/privacy/PrivacyScreen.js";

export default function PrivacyPage() {
  return (
    <Suspense>
      <PrivacyScreen />
    </Suspense>
  );
}
