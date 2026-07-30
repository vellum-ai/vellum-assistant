/**
 * Overflow menu for a local file rendered in the chat transcript: reveal the
 * file in the workspace browser, or download its bytes.
 *
 * The trigger swallows its own click and Enter/Space so opening the menu never
 * also activates the card or media it sits on.
 */

import { Download, Ellipsis, ExternalLink } from "lucide-react";
import { useCallback } from "react";
import type { KeyboardEvent, MouseEvent } from "react";

import { Button, cn, Menu, toast } from "@vellumai/design-library";

import { downloadLocalFile } from "@/domains/chat/components/local-file/download-local-file";
import { openWorkspaceFile } from "@/utils/open-workspace-file";

export interface LocalFileMenuProps {
  workspacePath: string | null;
  filename: string;
  assistantId?: string;
  /** True when the file is missing or otherwise unavailable. */
  disabled?: boolean;
  className?: string;
}

export function LocalFileMenu({
  workspacePath,
  filename,
  assistantId,
  disabled,
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
      await downloadLocalFile({
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
