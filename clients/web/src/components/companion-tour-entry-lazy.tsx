import { lazy, type ReactNode } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import {
  answerCompanionIntroAnnouncement,
  useCompanionIntroAnnouncement,
} from "@/runtime/companion-intro-announcement";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";

const CompanionTourEntryModal = lazy(() =>
  import("@/components/companion-tour-entry").then((module) => ({
    default: module.CompanionTourEntryModal,
  })),
);

function ElectronCompanionTourEntry(): ReactNode {
  const open = useCompanionIntroAnnouncement();
  if (!open) {
    return null;
  }

  return (
    <LazyBoundary>
      <CompanionTourEntryModal
        open
        onStart={() => answerCompanionIntroAnnouncement("start")}
        onDismiss={() => answerCompanionIntroAnnouncement("dismiss")}
      />
    </LazyBoundary>
  );
}

export function CompanionTourEntry(): ReactNode {
  if (!isElectron() || isPopoutWindowLifetime()) {
    return null;
  }
  return <ElectronCompanionTourEntry />;
}
