import { Button } from "@vellumai/design-library";
import { Calculator, FileText, Loader2 } from "lucide-react";

import { useTranslation } from "@/i18n";

import { useDesktopApps } from "./use-desktop-apps";

const APP_COPY = {
  calculator: {
    name: "desktopApps.calculator",
    description: "desktopApps.calculatorDescription",
    Icon: Calculator,
  },
  "text-editor": {
    name: "desktopApps.textEditor",
    description: "desktopApps.textEditorDescription",
    Icon: FileText,
  },
} as const;

export function DesktopAppsPanel({
  assistantId,
  connected,
  onOpened,
}: {
  assistantId: string;
  connected: boolean;
  onOpened?: () => void;
}) {
  const { t } = useTranslation("chat");
  const { query, action } = useDesktopApps(assistantId);
  return (
    <section
      aria-label={t("desktopApps.title")}
      className="flex h-full flex-col gap-4 overflow-y-auto p-4"
    >
      <div>
        <h3 className="text-body-medium-default">{t("desktopApps.title")}</h3>
        <p className="mt-1 text-body-small-lighter text-[var(--content-secondary)]">
          {t("desktopApps.description")}
        </p>
      </div>
      {query.isPending ? <p role="status">{t("desktopApps.loading")}</p> : null}
      {query.data?.apps.length === 0 ? (
        <p role="status">{t("desktopApps.unavailable")}</p>
      ) : null}
      {query.isError ? (
        <div role="alert">
          <p>{t("desktopApps.loadFailed")}</p>
          <Button variant="outlined" onClick={() => void query.refetch()}>
            {t("desktopApps.retry")}
          </Button>
        </div>
      ) : null}
      {query.data?.apps.map((app) => {
        const copy = APP_COPY[app.id];
        if (!copy) {
          return null;
        }
        const busy =
          app.state === "installing" ||
          (action.isPending && action.variables?.body.appId === app.id);
        const opening = app.state === "added";
        const failed =
          action.isError && action.variables?.body.appId === app.id;
        return (
          <div
            key={app.id}
            className="rounded-lg border border-[var(--border-subtle)] p-3"
          >
            <div className="flex items-center gap-3">
              <copy.Icon
                aria-hidden="true"
                className="h-6 w-6 shrink-0 text-[var(--content-secondary)]"
              />
              <div>
                <h4 className="text-body-medium-default">{t(copy.name)}</h4>
                <p className="text-body-small-lighter text-[var(--content-secondary)]">
                  {t(copy.description)}
                </p>
              </div>
            </div>
            {app.state === "failed" || failed ? (
              <p role="alert" className="mt-2 text-body-small-lighter">
                {t(
                  failed && opening
                    ? "desktopApps.openFailed"
                    : "desktopApps.installFailed",
                )}
              </p>
            ) : null}
            <div className="mt-3 flex items-center justify-between gap-2">
              <span
                role="status"
                className="text-body-small-lighter text-[var(--content-secondary)]"
              >
                {busy
                  ? t(
                      opening
                        ? "desktopApps.opening"
                        : "desktopApps.installing",
                    )
                  : opening
                    ? t("desktopApps.ready")
                    : app.state === "installed"
                      ? t("desktopApps.alreadyInstalled")
                      : t("desktopApps.optional")}
              </span>
              <Button
                variant="outlined"
                disabled={
                  action.isPending ||
                  app.state === "installing" ||
                  (opening && !connected)
                }
                onClick={() =>
                  action.mutate(
                    {
                      path: { assistant_id: assistantId },
                      body: { appId: app.id, action: opening ? "open" : "add" },
                    },
                    {
                      onSuccess: () => {
                        if (opening) {
                          onOpened?.();
                        }
                      },
                    },
                  )
                }
              >
                {busy ? (
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                ) : null}
                {t(
                  opening
                    ? "desktopApps.open"
                    : app.state === "installed"
                      ? "desktopApps.addLauncher"
                      : app.state === "failed"
                        ? "desktopApps.retry"
                        : "desktopApps.install",
                )}
              </Button>
            </div>
          </div>
        );
      })}
      <p className="text-body-small-lighter text-[var(--content-secondary)]">
        {t("desktopApps.pinHint")}
      </p>
      <p className="text-body-small-lighter text-[var(--content-secondary)]">
        {t("desktopApps.persistence")}
      </p>
    </section>
  );
}
