import { ChevronDown } from "lucide-react";
import type { Ref } from "react";
import { Button, Typography } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import { workspaceBasenameOf } from "@/utils/workspace-path-links";

interface WorkspaceFileTitleProps {
  selectedPath: string | null;
  open: boolean;
  onOpen: () => void;
  pickerId: string;
  buttonRef: Ref<HTMLButtonElement>;
}

export function WorkspaceFileTitle({
  selectedPath,
  open,
  onOpen,
  pickerId,
  buttonRef,
}: WorkspaceFileTitleProps) {
  const { t } = useTranslation("workspace");
  return (
    <div className="mx-auto flex min-w-0 max-w-[min(32rem,calc(100vw-136px))] flex-col items-center gap-1.5">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {t("workspaceFileTitle.eyebrow")}
      </Typography>
      <Button
        ref={buttonRef}
        variant="ghost"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        aria-describedby={`${pickerId}-hint`}
        className="workspace-file-title bg-[var(--surface-hover)]"
      >
        <span className="min-w-0 truncate">
          {selectedPath
            ? workspaceBasenameOf(selectedPath)
            : t("workspaceFileTitle.chooseFile")}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0"
          strokeWidth={2.2}
          aria-hidden
        />
      </Button>
      <span id={`${pickerId}-hint`} className="sr-only">
        {t("workspaceFileTitle.openHint")}
      </span>
    </div>
  );
}
