import { Suspense } from "react";

import { HatchingScreen } from "@/domains/onboarding/hatching/HatchingScreen.js";

export default function HatchingPage() {
  return (
    <Suspense>
      <HatchingScreen />
    </Suspense>
  );
}
