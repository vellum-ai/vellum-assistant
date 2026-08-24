import { Link2 } from "lucide-react";

import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";

interface ShareConnectionLinkButtonProps {
  onClick: () => void;
}

export function ShareConnectionLinkButton({
  onClick,
}: ShareConnectionLinkButtonProps) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outlined"
      size="compact"
      leftIcon={<Link2 className="h-3.5 w-3.5" />}
      onClick={onClick}
    >
      {t("shareConnectionLinkButton.label")}
    </Button>
  );
}
