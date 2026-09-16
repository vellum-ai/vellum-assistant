import { Button } from "@vellumai/design-library";
import { lazy, Suspense } from "react";

import { useTranslation } from "@/i18n";

import { DesktopStatus } from "./desktop-status";
import { useDesktopSetup } from "./use-desktop-setup";

const DesktopViewer = lazy(() =>
  import("./desktop-viewer").then((module) => ({
    default: module.DesktopViewer,
  })),
);

interface DesktopPanelProps {
  assistantId: string;
  viewOnly?: boolean;
}

const SETUP_STAGE_KEY = {
  packages: "assistantDesktop.installingPackages",
  chrome: "assistantDesktop.installingChrome",
  checking: "assistantDesktop.checkingInstall",
} as const;

export function DesktopPanel({ assistantId, viewOnly }: DesktopPanelProps) {
  const { t } = useTranslation("chat");
  const { query, install } = useDesktopSetup(assistantId);
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
  const busy =
    !install.isError &&
    (query.isPending ||
      install.isPending ||
      setup?.state === "installing" ||
      setup?.state === "required");
  const failed = query.isError || install.isError || setup?.state === "failed";
  return (
    <DesktopStatus
      loading={busy}
      message={
        query.isError || install.isError
          ? t("assistantDesktop.setupRequestFailed")
          : failed
            ? t("assistantDesktop.installFailed")
            : setup?.state === "unsupported"
              ? t("assistantDesktop.setupUnsupported")
              : setup?.state === "installing"
                ? t(SETUP_STAGE_KEY[setup.stage ?? "packages"])
                : t("assistantDesktop.checkingSetup")
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
      ) : install.isError || setup?.state === "failed" ? (
        <Button
          variant="outlined"
          disabled={busy}
          onClick={() =>
            install.mutate({ path: { assistant_id: assistantId } })
          }
        >
          {t("assistantDesktop.installButton")}
        </Button>
      ) : null}
    </DesktopStatus>
  );
}
