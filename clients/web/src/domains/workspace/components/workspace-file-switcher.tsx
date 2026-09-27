import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";
import {
  workspaceBasenameOf,
  workspaceDirOf,
} from "@/utils/workspace-path-links";

export interface WorkspaceFilePickerControl {
  open: boolean;
  onOpen: () => void;
  pickerId: string;
  buttonRef: Ref<HTMLButtonElement>;
}

interface WorkspaceFileSwitcherProps extends WorkspaceFilePickerControl {
  selectedPath: string | null;
  icon: ReactNode;
}

export function WorkspaceFileSwitcher({
  selectedPath,
  icon,
  open,
  onOpen,
  pickerId,
  buttonRef,
}: WorkspaceFileSwitcherProps) {
  const { t } = useTranslation("workspace");
  const parent = selectedPath ? workspaceDirOf(selectedPath) : "";
  const prefix = parent
    ? `${workspaceDirOf(parent) ? "…/" : ""}${workspaceBasenameOf(parent)}/`
    : "";

  return (
    <>
      <Button
        ref={buttonRef}
        variant="ghost"
        onClick={onOpen}
        aria-label={
          selectedPath
            ? t("workspaceFileSwitcher.switchFile", { path: selectedPath })
            : t("workspaceFileSwitcher.chooseFile")
        }
        title={selectedPath ?? undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        aria-describedby={`${pickerId}-hint`}
        data-empty={!selectedPath}
        className="workspace-file-switcher"
      >
        {selectedPath ? icon : null}
        <span className="min-w-0 truncate">
          {selectedPath ? (
            <>
              <span className="font-normal text-[var(--content-tertiary)]">
                {prefix}
              </span>
              {workspaceBasenameOf(selectedPath)}
            </>
          ) : (
            t("workspaceFileSwitcher.chooseFile")
          )}
        </span>
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-[var(--content-secondary)]"
          strokeWidth={2.2}
          aria-hidden
        />
      </Button>
      <span id={`${pickerId}-hint`} className="sr-only">
        {t("workspaceFileSwitcher.openHint")}
      </span>
    </>
  );
}
