import { Button } from "@vellumai/design-library";
import { lazy, Suspense } from "react";

import { useTranslation } from "@/i18n";

import { DesktopControlPanel } from "./desktop-control-panel";
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
      <DesktopControlPanel assistantId={assistantId}>
        {(assistantOwnsInput) => (
          <Suspense
            fallback={
              <DesktopStatus
                loading
                message={t("assistantDesktop.connecting")}
              />
            }
          >
            <DesktopViewer
              key={assistantId}
              assistantId={assistantId}
              viewOnly={viewOnly || assistantOwnsInput}
            />
          </Suspense>
        )}
      </DesktopControlPanel>
    );
  }
  const busy =
    query.isPending || install.isPending || setup?.state === "installing";
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
                : busy
                  ? t("assistantDesktop.checkingSetup")
                  : t("assistantDesktop.installDescription")
      }
    >
      {query.isError || install.isError ? (
        <Button
          variant="outlined"
          onClick={() => {
            install.reset();
            void query.refetch();
          }}
        >
          {t("assistantDesktop.reconnectButton")}
        </Button>
      ) : setup?.state === "required" || setup?.state === "failed" ? (
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
