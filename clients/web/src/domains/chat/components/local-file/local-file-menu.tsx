/**
 * Overflow menu for a local file rendered in the chat transcript: reveal the
 * file in the workspace browser, pop a video out into Picture in Picture, or
 * download its bytes.
 *
 * The trigger swallows its own click and Enter/Space so opening the menu never
 * also activates the card or media it sits on.
 */

import {
  Download,
  Ellipsis,
  ExternalLink,
  PictureInPicture2,
} from "lucide-react";
import { useCallback } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

import { Button, cn, Menu, toast } from "@vellumai/design-library";

import { downloadWorkspaceFile } from "@/utils/download-workspace-file";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

export interface LocalFileMenuProps {
  workspacePath: string | null;
  filename: string;
  assistantId?: string;
  /** True when the file is missing or otherwise unavailable. */
  disabled?: boolean;
  /**
   * Supplied only by video embeds in a browser that supports Picture in
   * Picture. It acts on the already-loaded element, so it stays enabled even
   * when the file itself is unavailable.
   */
  onPictureInPicture?: () => void;
  className?: string;
}

export function LocalFileMenu({
  workspacePath,
  filename,
  assistantId,
  disabled,
  onPictureInPicture,
  className,
}: LocalFileMenuProps) {
  const isDisabled = disabled === true || workspacePath === null;

  const handleGoToFile = useCallback(() => {
    if (workspacePath === null) {
      return;
    }
    void openWorkspaceFile(workspacePath);
  }, [workspacePath]);

  const handleDownload = useCallback(async () => {
    if (workspacePath === null || !assistantId) {
      return;
    }
    try {
      await downloadWorkspaceFile({
        assistantId,
        path: workspacePath,
        filename,
      });
    } catch {
      toast.error("Failed to download file", { description: filename });
    }
  }, [assistantId, filename, workspacePath]);

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button
          variant="ghost"
          size="compact"
          expandOnMobile={false}
          iconOnly={<Ellipsis />}
          aria-label="File actions"
          className={cn("shrink-0", className)}
          onClick={(event: MouseEvent) => event.stopPropagation()}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={<ExternalLink size={14} />}
          disabled={isDisabled}
          onSelect={handleGoToFile}
          className="whitespace-nowrap"
        >
          Go to file
        </Menu.Item>
        {onPictureInPicture !== undefined && (
          <Menu.Item
            leftIcon={<PictureInPicture2 size={14} />}
            onSelect={onPictureInPicture}
            className="whitespace-nowrap"
          >
            Picture in Picture
          </Menu.Item>
        )}
        <Menu.Item
          leftIcon={<Download size={14} />}
          disabled={isDisabled || !assistantId}
          onSelect={() => void handleDownload()}
          className="whitespace-nowrap"
        >
          Download
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
