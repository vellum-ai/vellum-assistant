import { lazy, type ReactNode } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { assistantDisplayName } from "@/utils/assistant-display-name";
import {
  answerCompanionIntroAnnouncement,
  useCompanionIntroAnnouncement,
} from "@/runtime/companion-intro-announcement";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";

import type { CompanionTourEntryModalProps } from "./companion-tour-entry";

const CompanionTourEntryModal = lazy(() =>
  import("@/components/companion-tour-entry").then((module) => ({
    default: module.CompanionTourEntryModal,
  })),
);

type CompanionTourEntryProps = Pick<CompanionTourEntryModalProps, "avatar"> & {
  ready: boolean;
};

function ElectronCompanionTourEntry({
  avatar,
  ready,
}: CompanionTourEntryProps): ReactNode {
  const name = useAssistantIdentityStore.use.name();
  const open = useCompanionIntroAnnouncement();
  if (!ready || !open) {
    return null;
  }

  return (
    <LazyBoundary>
      <CompanionTourEntryModal
        avatar={avatar}
        assistantName={assistantDisplayName(name)}
        open
        onStart={() => answerCompanionIntroAnnouncement("start")}
        onDismiss={() => answerCompanionIntroAnnouncement("dismiss")}
      />
    </LazyBoundary>
  );
}

export function CompanionTourEntry(props: CompanionTourEntryProps): ReactNode {
  if (!isElectron() || isPopoutWindowLifetime()) {
    return null;
  }
  return <ElectronCompanionTourEntry {...props} />;
}
