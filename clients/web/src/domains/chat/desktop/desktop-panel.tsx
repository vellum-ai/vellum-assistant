import { Button } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { lazy, Suspense } from "react";

import { useTranslation } from "@/i18n";

import { useDesktopSetup } from "./use-desktop-setup";

const DesktopViewer = lazy(() =>
  import("./desktop-viewer").then((module) => ({
    default: module.DesktopViewer,
  })),
);

interface DesktopPanelProps {
  assistantId: string;
}

const SETUP_STAGE_KEY = {
  packages: "assistantDesktop.installingPackages",
  chrome: "assistantDesktop.installingChrome",
  checking: "assistantDesktop.checkingInstall",
} as const;

export function DesktopPanel({ assistantId }: DesktopPanelProps) {
  const { t } = useTranslation("chat");
  const { query, install } = useDesktopSetup(assistantId);
  const setup = query.data;
  if (setup?.state === "ready") {
    return (
      <Suspense
        fallback={<p role="status">{t("assistantDesktop.connecting")}</p>}
      >
        <DesktopViewer key={assistantId} assistantId={assistantId} />
      </Suspense>
    );
  }
  const busy =
    query.isPending || install.isPending || setup?.state === "installing";
  const failed = query.isError || install.isError || setup?.state === "failed";
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      role="status"
      aria-live="polite"
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
      <p className="text-body-medium-lighter">
        {query.isError || install.isError
          ? t("assistantDesktop.setupRequestFailed")
          : failed
            ? t("assistantDesktop.installFailed")
            : setup?.state === "unsupported"
              ? t("assistantDesktop.setupUnsupported")
              : setup?.state === "installing"
                ? t(SETUP_STAGE_KEY[setup.stage ?? "packages"])
                : busy
                  ? t("assistantDesktop.checkingSetup")
                  : t("assistantDesktop.installDescription")}
      </p>
      {setup?.state === "installing" ? (
        <p className="text-body-small-lighter text-[var(--content-tertiary)]">
          {t("assistantDesktop.installBackground")}
        </p>
      ) : null}
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
    </div>
  );
}
