
import { ArrowUp, ChevronUp, Globe, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@vellum/design-library";
import { Typography } from "@vellum/design-library";
import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { cn } from "@/utils/misc.js";

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
  onClose: () => void;
}

export function AppNavBar({ appName, onEdit, isEditing, onShare, isSharing, onDeploy, isDeploying, onClose }: AppNavBarProps) {
  const isMobile = useIsMobile();
  // While the bar is acting as the minimized strip on mobile, tapping the
  // title is the primary "open app" affordance — same callback as the
  // chevron-up icon next to it.
  const titleClickEnabled = isMobile && isEditing === true && onEdit != null;

  return (
    <div className="flex items-center justify-between rounded-t-xl bg-[var(--surface-lift)] px-4 py-3">
      <div className="hidden md:flex items-center min-w-[72px]">
        {onEdit != null && (
          <Button onClick={onEdit}>{isEditing ? "Close chat" : "Edit"}</Button>
        )}
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
        {onDeploy != null && (
          <Button
            variant="outlined"
            iconOnly={isDeploying ? <Loader2 className="animate-spin" /> : <Globe />}
            onClick={onDeploy}
            disabled={isDeploying}
            tooltip={isDeploying ? "Deploying…" : "Deploy"}
          />
        )}
        {onShare != null && (
          <Button
            variant="outlined"
            iconOnly={isSharing ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            onClick={onShare}
            disabled={isSharing}
            tooltip={isSharing ? "Sharing…" : "Share"}
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
        <Button variant="outlined" iconOnly={<X />} onClick={onClose} tooltip="Close" />
      </div>
    </div>
  );
}
