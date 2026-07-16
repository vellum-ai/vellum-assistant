import {
  ChevronUp,
  Globe,
  Loader2,
  Maximize2,
  Pencil,
  Share,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { cn } from "@/utils/misc";
import {
  BottomSheet,
  Button,
  Menu,
  PanelItem,
  Typography,
} from "@vellumai/design-library";

export interface AppNavBarProps {
  appName: string;
  onEdit?: () => void;
  /**
   * Desktop: flips the left button label to "Close chat".
   * Mobile: swaps the right-side edit icon to a chevron-up + active state,
   * marking the bar as the slide-up affordance for the minimized app strip.
   */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /** When provided, renders a fullscreen toggle button in the right group. */
  onToggleFullscreen?: () => void;
  onClose: () => void;
  /**
   * When provided, the app name becomes inline-editable: clicking the name
   * turns it into a text input. Saves on Enter or blur, cancels on Escape.
   * Empty names revert to the original.
   */
  onRename?: (newName: string) => Promise<void>;
}

export function AppNavBar({
  appName,
  onEdit,
  isEditing,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  onToggleFullscreen,
  onClose,
  onRename,
}: AppNavBarProps) {
  const isMobile = useIsMobile();
  // While the bar is acting as the minimized strip on mobile, tapping the
  // title is the primary "open app" affordance, same callback as the
  // chevron-up icon next to it.
  const titleClickEnabled = isMobile && isEditing === true && onEdit != null;

  // When both share and deploy are available, collapse them into a single
  // dropdown trigger so the right-side button group stays compact and the
  // two actions live behind one affordance, matching the library card's
  // `...` menu shape.
  const showShareDeployMenu = onShare != null && onDeploy != null;

  // --- Inline rename state ---
  const [isRenaming, setIsRenaming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draftName, setDraftName] = useState(appName);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft when appName prop changes externally
  useEffect(() => {
    if (!isRenaming) {
      setDraftName(appName);
    }
  }, [appName, isRenaming]);

  // Focus and select all text when entering edit mode
  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  const canRename = onRename != null && !titleClickEnabled;

  const startRenaming = (e: React.MouseEvent) => {
    if (!canRename || isRenaming) return;
    e.stopPropagation();
    setDraftName(appName);
    setIsRenaming(true);
  };

  const cancelRenaming = () => {
    setIsRenaming(false);
    setDraftName(appName);
  };

  const commitRename = async () => {
    const trimmed = draftName.trim();
    if (!trimmed || trimmed === appName) {
      cancelRenaming();
      return;
    }
    setIsSaving(true);
    try {
      await onRename?.(trimmed);
      setIsRenaming(false);
      setDraftName(trimmed);
    } catch {
      cancelRenaming();
    } finally {
      setIsSaving(false);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRenaming();
    }
  };

  const renderAppName = () => {
    if (isRenaming) {
      return (
        <input
          ref={inputRef}
          type="text"
          value={draftName}
          disabled={isSaving}
          onChange={(e) => setDraftName(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={handleNameKeyDown}
          className={cn(
            "flex-1 min-w-0 rounded-md border border-[var(--border-default)] bg-[var(--surface-base)] px-2 py-0.5",
            "text-left md:text-center text-[var(--content-emphasised)] outline-none",
            "focus:border-[var(--border-focus)]",
          )}
          style={{ lineHeight: 1.4 }}
          aria-label="App name"
        />
      );
    }

    const isClickable = canRename || titleClickEnabled;
    return (
      <Typography
        variant="body-large-default"
        className={cn(
          "flex-1 truncate text-left md:text-center text-[var(--content-emphasised)]",
          isClickable && "cursor-pointer",
        )}
        style={{ lineHeight: 1.4 }}
        onClick={
          titleClickEnabled ? onEdit : canRename ? startRenaming : undefined
        }
      >
        {appName}
        {isSaving && (
          <Loader2 className="ml-1 inline h-3.5 w-3.5 animate-spin align-middle" />
        )}
      </Typography>
    );
  };

  return (
    <div className="flex items-center justify-between rounded-t-xl bg-[var(--surface-lift)] px-4 py-3">
      <div className="hidden md:flex items-center min-w-[72px]">
        {onEdit != null && (
          <Button onClick={onEdit}>{isEditing ? "Close chat" : "Edit"}</Button>
        )}
      </div>

      {renderAppName()}

      <div className="flex items-center gap-1.5 min-w-[72px] justify-end">
        {showShareDeployMenu ? (
          <ShareDeployMenuTrigger
            onShare={onShare}
            isSharing={isSharing}
            onDeploy={onDeploy}
            isDeploying={isDeploying}
            isMobile={isMobile}
          />
        ) : (
          <>
            {onDeploy != null && (
              <Button
                variant="outlined"
                iconOnly={
                  isDeploying ? <Loader2 className="animate-spin" /> : <Globe />
                }
                onClick={onDeploy}
                disabled={isDeploying}
                tooltip={isDeploying ? "Deploying..." : "Deploy"}
              />
            )}
            {onShare != null && (
              <Button
                variant="outlined"
                iconOnly={
                  isSharing ? <Loader2 className="animate-spin" /> : <Share />
                }
                onClick={onShare}
                disabled={isSharing}
                tooltip={isSharing ? "Sharing..." : "Share"}
              />
            )}
          </>
        )}
        {onToggleFullscreen != null && (
          <Button
            variant="outlined"
            iconOnly={<Maximize2 />}
            onClick={onToggleFullscreen}
            tooltip="Fullscreen"
          />
        )}
        {onEdit != null && (
          <Button
            variant="outlined"
            iconOnly={isEditing ? <ChevronUp /> : <Pencil />}
            onClick={onEdit}
            tooltip={isEditing ? "Open app" : "Edit"}
            active={isEditing}
            className="md:hidden"
          />
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          tooltip="Close"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share + Deploy to Vercel dropdown
//
// Single trigger that opens a dropdown listing both actions. Used whenever
// both `onShare` and `onDeploy` are provided to the nav bar, collapses two
// adjacent icon buttons into one affordance. Matches the library card's
// `...` menu shape (desktop dropdown + mobile bottom sheet).
// ---------------------------------------------------------------------------

interface ShareDeployMenuTriggerProps {
  onShare: () => void;
  isSharing?: boolean;
  onDeploy: () => void;
  isDeploying?: boolean;
  isMobile: boolean;
}

function ShareDeployMenuTrigger({
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  isMobile,
}: ShareDeployMenuTriggerProps) {
  const [open, setOpen] = useState(false);
  const isBusy = isSharing || isDeploying;
  const triggerIcon = isBusy ? <Loader2 className="animate-spin" /> : <Share />;
  const triggerTooltip = isSharing
    ? "Sharing..."
    : isDeploying
      ? "Deploying..."
      : "Share & deploy";

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="outlined"
            iconOnly={triggerIcon}
            disabled={isBusy}
            tooltip={triggerTooltip}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content aria-describedby={undefined}>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>Share & deploy</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            <PanelItem
              icon={Share}
              label={
                <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                  <span>Share</span>
                  <span className="text-body-small-default text-[var(--content-tertiary)]">
                    Export as .vellum file
                  </span>
                </span>
              }
              onSelect={() => {
                setOpen(false);
                onShare();
              }}
            />
            <PanelItem
              icon={Globe}
              label={
                <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                  <span>Deploy to Vercel</span>
                  <span className="text-body-small-default text-[var(--content-tertiary)]">
                    Publish as a static page
                  </span>
                </span>
              }
              onSelect={() => {
                setOpen(false);
                onDeploy();
              }}
            />
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <Button
          variant="outlined"
          iconOnly={triggerIcon}
          disabled={isBusy}
          tooltip={triggerTooltip}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={<Share size={14} />}
          onSelect={() => onShare()}
          className="whitespace-nowrap"
        >
          Share
        </Menu.Item>
        <Menu.Item
          leftIcon={<Globe size={14} />}
          onSelect={() => onDeploy()}
          className="whitespace-nowrap"
        >
          Deploy to Vercel
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
