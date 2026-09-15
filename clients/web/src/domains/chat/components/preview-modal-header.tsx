import { Button, Typography } from "@vellumai/design-library";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { useTranslation } from "@/i18n";

interface PreviewModalHeaderProps {
  title: string;
  leading?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}

export function PreviewModalHeader({
  title,
  leading,
  actions,
  onClose,
}: PreviewModalHeaderProps) {
  const { t } = useTranslation("chat");
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-3 px-4"
      style={{
        paddingTop:
          "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)",
      }}
    >
      <div className="pointer-events-auto w-11 shrink-0 truncate">{leading}</div>
      <Typography
        as="div"
        variant="body-medium-lighter"
        className="min-w-0 flex-1 truncate text-center text-white/90"
      >
        <span className="pointer-events-auto">{title}</span>
      </Typography>
      <div className="pointer-events-auto flex shrink-0 items-center gap-2">
        {actions}
        <Button
          variant="ghost"
          iconOnly={<X />}
          expandOnMobile={false}
          onClick={onClose}
          aria-label={t("attachmentPreviewModal.closePreviewAria")}
          className="h-11 w-11 rounded-full bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
          tintColor="currentColor"
        />
      </div>
    </div>
  );
}
