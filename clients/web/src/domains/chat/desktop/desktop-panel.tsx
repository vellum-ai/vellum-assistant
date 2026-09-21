import { Button } from "@vellumai/design-library";
import { lazy, Suspense } from "react";

import { useTranslation } from "@/i18n";

import { DesktopStatus } from "./desktop-status";
import { useDesktopSetupStatus } from "./use-desktop-setup";

const DesktopViewer = lazy(() =>
  import("./desktop-viewer").then((module) => ({
    default: module.DesktopViewer,
  })),
);

interface DesktopPanelProps {
  assistantId: string;
  viewOnly?: boolean;
}

export function DesktopPanel({ assistantId, viewOnly }: DesktopPanelProps) {
  const { t } = useTranslation("chat");
  const { query } = useDesktopSetupStatus(assistantId);
  const setup = query.data;
  if (setup?.state === "ready") {
    return (
      <Suspense
        fallback={
          <DesktopStatus loading message={t("assistantDesktop.connecting")} />
        }
      >
        <DesktopViewer
          key={assistantId}
          assistantId={assistantId}
          viewOnly={viewOnly}
        />
      </Suspense>
    );
  }
  return (
    <DesktopStatus
      loading={query.isPending}
      message={
        query.isError
          ? t("assistantDesktop.setupRequestFailed")
          : query.isPending
            ? t("assistantDesktop.checkingSetup")
            : t("assistantDesktop.unavailable")
      }
    >
      {query.isError ? (
        <Button
          variant="outlined"
          onClick={() => {
            void query.refetch();
          }}
        >
          {t("assistantDesktop.reconnectButton")}
        </Button>
      ) : null}
    </DesktopStatus>
  );
}
