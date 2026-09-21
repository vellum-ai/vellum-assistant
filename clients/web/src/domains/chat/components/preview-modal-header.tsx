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
      className="pointer-events-none absolute inset-x-0 top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4"
      style={{
        paddingTop:
          "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) + 1rem)",
      }}
    >
      <div className="pointer-events-auto w-11 shrink-0 truncate">
        {leading}
      </div>
      <Typography
        as="div"
        variant="body-medium-lighter"
        className="max-w-[30vw] truncate text-center text-white/90"
      >
        <span className="pointer-events-auto">{title}</span>
      </Typography>
      <div className="pointer-events-auto flex min-w-0 items-center justify-end gap-2">
        {actions}
        <Button
          size="large"
          shape="pill"
          variant="ghost"
          iconOnly={<X />}
          expandOnMobile={false}
          onClick={onClose}
          aria-label={t("attachmentPreviewModal.closePreviewAria")}
          className="bg-white/10 text-white/70 hover:bg-white/20 hover:text-white"
          tintColor="currentColor"
        />
      </div>
    </div>
  );
}
