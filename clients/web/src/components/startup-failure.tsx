import { useEffect } from "react";

import { useTranslation } from "@/i18n";
import { markNativeLaunchScreenReady } from "@/runtime/native-launch-screen";

export const STARTUP_FAILURE_TITLE = "Vellum couldn't start";
export const STARTUP_FAILURE_MESSAGE =
  "Reload the app to try again. If this keeps happening, update or reinstall the app.";

export function StartupFailure() {
  const { t } = useTranslation();

  useEffect(() => {
    void markNativeLaunchScreenReady("system");
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--background)] p-6 text-[var(--content-primary)]">
      <div role="alert" className="max-w-md text-center">
        <h1 className="text-xl font-semibold">{STARTUP_FAILURE_TITLE}</h1>
        <p className="mt-2 text-sm text-[var(--content-secondary)]">
          {STARTUP_FAILURE_MESSAGE}
        </p>
        <button
          type="button"
          className="mt-5 rounded-md bg-[var(--background-brand)] px-4 py-2 text-sm font-medium text-white"
          onClick={() => window.location.reload()}
        >
          {t("startupFailure.reloadApp")}
        </button>
      </div>
    </main>
  );
}
