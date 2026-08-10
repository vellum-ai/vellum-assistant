import {
  ChevronUp,
  Expand,
  Globe,
  Link2,
  Loader2,
  Maximize2,
  Pencil,
  RefreshCw,
  Share,
  X,
} from "lucide-react";
import { useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
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
   * Desktop: swaps the left "Edit" button for an expand icon that drops the
   * chat panel and gives the app the full width.
   * Mobile: swaps the right-side edit icon to a chevron-up + active state,
   * marking the bar as the slide-up affordance for the minimized app strip.
   */
  isEditing?: boolean;
  onShare?: () => void;
  isSharing?: boolean;
  onDeploy?: () => void;
  isDeploying?: boolean;
  /**
   * Live URL of the app's active Vercel deployment, when it has one. Turns
   * the deploy affordance into "Deployed to Vercel" (which hands back the
   * link) plus an explicit Redeploy, instead of offering a first-time deploy
   * for an app that is already published.
   */
  deployedUrl?: string | null;
  /** Invoked by the deployed-state item; copies the link and shows it. */
  onCopyDeployedLink?: () => void;
  /** When provided, renders a fullscreen toggle button in the right group. */
  onToggleFullscreen?: () => void;
  onClose: () => void;
}

export function AppNavBar({
  appName,
  onEdit,
  isEditing,
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  deployedUrl,
  onCopyDeployedLink,
  onToggleFullscreen,
  onClose,
}: AppNavBarProps) {
  const isMobile = useIsMobile();
  // While the bar is acting as the minimized strip on mobile, tapping the
  // title is the primary "open app" affordance — same callback as the
  // chevron-up icon next to it.
  const titleClickEnabled = isMobile && isEditing === true && onEdit != null;

  // When both share and deploy are available, collapse them into a single
  // dropdown trigger so the right-side button group stays compact and the
  // two actions live behind one affordance — matching the library card's
  // `...` menu shape.
  const showShareDeployMenu = onShare != null && onDeploy != null;

  // An app is only treated as deployed when the caller can also hand the link
  // back. Otherwise the affordance would report a deployment it can't reach.
  const isDeployed =
    deployedUrl != null && deployedUrl !== "" && onCopyDeployedLink != null;

  return (
    <div className="flex items-center justify-between rounded-t-xl bg-[var(--surface-lift)] px-4 py-3">
      <div className="hidden md:flex items-center min-w-[72px]">
        {onEdit != null &&
          (isEditing ? (
            <Button
              variant="outlined"
              iconOnly={<Expand />}
              onClick={onEdit}
              tooltip="Expand app"
              aria-label="Expand app"
            />
          ) : (
            <Button onClick={onEdit}>Edit</Button>
          ))}
      </div>

      <Typography
        variant="body-large-default"
        className={cn(
          "flex-1 truncate text-left md:text-center text-[var(--content-emphasised)]",
          titleClickEnabled && "cursor-pointer",
        )}
        style={{ lineHeight: 1.4 }}
        onClick={titleClickEnabled ? onEdit : undefined}
      >
        {appName}
      </Typography>

      <div className="flex items-center gap-1.5 min-w-[72px] justify-end">
        {showShareDeployMenu ? (
          <ShareDeployMenuTrigger
            onShare={onShare}
            isSharing={isSharing}
            onDeploy={onDeploy}
            isDeploying={isDeploying}
            deployedUrl={deployedUrl}
            onCopyDeployedLink={onCopyDeployedLink}
          />
        ) : (
          <>
            {onDeploy != null &&
              (isDeployed ? (
                <Button
                  variant="outlined"
                  iconOnly={<Link2 />}
                  onClick={onCopyDeployedLink}
                  tooltip="Deployed: copy link"
                  aria-label="Deployed to Vercel, copy link"
                />
              ) : (
                <Button
                  variant="outlined"
                  iconOnly={
                    isDeploying ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Globe />
                    )
                  }
                  onClick={onDeploy}
                  disabled={isDeploying}
                  tooltip={isDeploying ? "Deploying…" : "Deploy"}
                  aria-label={isDeploying ? "Deploying…" : "Deploy"}
                />
              ))}
            {onShare != null && (
              <Button
                variant="outlined"
                iconOnly={
                  isSharing ? <Loader2 className="animate-spin" /> : <Share />
                }
                onClick={onShare}
                disabled={isSharing}
                tooltip={isSharing ? "Sharing…" : "Share"}
                aria-label={isSharing ? "Sharing…" : "Share"}
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
            aria-label="Fullscreen"
          />
        )}
        {onEdit != null && (
          <Button
            variant="outlined"
            iconOnly={isEditing ? <ChevronUp /> : <Pencil />}
            onClick={onEdit}
            tooltip={isEditing ? "Open app" : "Edit"}
            aria-label={isEditing ? "Open app" : "Edit"}
            active={isEditing}
            className="md:hidden"
          />
        )}
        <Button
          variant="outlined"
          iconOnly={<X />}
          onClick={onClose}
          tooltip="Close"
          aria-label="Close"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Share + Deploy to Vercel dropdown
//
// Single trigger that opens a dropdown listing both actions. Used whenever
// both `onShare` and `onDeploy` are provided to the nav bar — collapses two
// adjacent icon buttons into one affordance. Matches the library card's
// `...` menu shape (desktop dropdown + mobile bottom sheet).
// ---------------------------------------------------------------------------

interface ShareDeployMenuTriggerProps {
  onShare: () => void;
  isSharing?: boolean;
  onDeploy: () => void;
  isDeploying?: boolean;
  deployedUrl?: string | null;
  onCopyDeployedLink?: () => void;
}

function ShareDeployMenuTrigger({
  onShare,
  isSharing,
  onDeploy,
  isDeploying,
  deployedUrl,
  onCopyDeployedLink,
}: ShareDeployMenuTriggerProps) {
  const isTouchMobile = useTouchMobile();
  const [open, setOpen] = useState(false);
  const isDeployed =
    deployedUrl != null && deployedUrl !== "" && onCopyDeployedLink != null;
  const isBusy = isSharing || isDeploying;
  const triggerIcon = isBusy ? <Loader2 className="animate-spin" /> : <Share />;
  const triggerTooltip = isSharing
    ? "Sharing…"
    : isDeploying
    ? "Deploying…"
    : "Share & deploy";

  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="outlined"
            iconOnly={triggerIcon}
            disabled={isBusy}
            tooltip={triggerTooltip}
            aria-label={triggerTooltip}
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
            {isDeployed ? (
              <>
                <PanelItem
                  icon={Link2}
                  label={
                    <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                      <span>Deployed to Vercel</span>
                      <span className="break-all text-body-small-default text-[var(--content-tertiary)]">
                        {deployedUrl}
                      </span>
                    </span>
                  }
                  onSelect={() => {
                    setOpen(false);
                    onCopyDeployedLink?.();
                  }}
                />
                <PanelItem
                  icon={RefreshCw}
                  label={
                    <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                      <span>Redeploy</span>
                      <span className="text-body-small-default text-[var(--content-tertiary)]">
                        Publish the current version
                      </span>
                    </span>
                  }
                  onSelect={() => {
                    setOpen(false);
                    onDeploy();
                  }}
                />
              </>
            ) : (
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
            )}
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
          aria-label={triggerTooltip}
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
        {isDeployed ? (
          <>
            <Menu.Item
              leftIcon={<Link2 size={14} />}
              shortcut="Copy link"
              onSelect={() => onCopyDeployedLink?.()}
              className="whitespace-nowrap"
            >
              Deployed to Vercel
            </Menu.Item>
            <Menu.Item
              leftIcon={<RefreshCw size={14} />}
              onSelect={() => onDeploy()}
              className="whitespace-nowrap"
            >
              Redeploy
            </Menu.Item>
          </>
        ) : (
          <Menu.Item
            leftIcon={<Globe size={14} />}
            onSelect={() => onDeploy()}
            className="whitespace-nowrap"
          >
            Deploy to Vercel
          </Menu.Item>
        )}
      </Menu.Content>
    </Menu.Root>
  );
}
