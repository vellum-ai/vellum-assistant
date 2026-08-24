import { useNavigate } from "react-router";
import { useTranslation } from "@/i18n";

import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

export function SelfHostedScreen() {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  return (
    <div className="flex w-full flex-col items-center justify-center px-4 py-24">
      <div
        className="flex h-16 w-16 items-center justify-center rounded-xl bg-[var(--surface-base)]"
        style={{ animation: "fadeInUp 0.5s ease-out forwards" }}
      >
        {/* typography: off-scale — emoji hero sized via text-3xl */}
        <span className="text-3xl" role="img" aria-label="house">
          &#x1F3E0;
        </span>
      </div>
      <h2 className="mt-8 text-title-medium text-[var(--content-default)]">
        {t("selfHostedScreen.title")}
      </h2>
      <p className="mt-3 max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
        {t("selfHostedScreen.body")}
      </p>
      <Button
        variant="primary"
        onClick={() => navigate(routes.settings.root)}
        className="mt-6"
      >
        {t("selfHostedScreen.openSettings")}
      </Button>
    </div>
  );
}
