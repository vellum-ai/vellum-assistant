import { Cog, Plug } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  Button,
  Popover,
  Typography,
} from "@vellumai/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { routes } from "@/utils/routes";

import { useEffectiveChatPlugins } from "./use-effective-chat-plugins";

export interface InChatPluginPillProps {
  assistantId: string;
  conversationId: string;
}

/** Warns that per-chat plugin changes (made on the plugins page) can be costly. */
const COST_CAPTION = "Changing plugin settings can incur high costs.";

/**
 * Top-right chat pill summarizing the conversation's active plugins. Clicking it
 * opens a read-only list of those plugins plus a "Manage" shortcut to the
 * plugins page — editing the set happens there, not in this menu. Mirrors
 * `ConversationAssetsPill`'s top-right placement and desktop-popover /
 * mobile-bottom-sheet split.
 */
export function InChatPluginPill({
  assistantId,
  conversationId,
}: InChatPluginPillProps) {
  const { plugins, selectedCount, total, isResolved } = useEffectiveChatPlugins(
    assistantId,
    conversationId,
  );
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const handleManage = useCallback(() => {
    setOpen(false);
    navigate(routes.plugins);
  }, [navigate]);

  // Nothing to summarize (no installed plugins), or the chat's scope isn't known
  // yet (an existing chat's detail is still loading) — wait rather than show the
  // default/all-selected scope for an explicitly scoped chat.
  if (total === 0 || !isResolved) {
    return null;
  }

  const active = plugins.filter((plugin) => plugin.selected);
  const label = selectedCount === 1 ? "1 plugin" : `${selectedCount} plugins`;
  const ariaLabel = `Chat plugins, ${selectedCount} active`;

  // Read-only rows — the chat's active plugins, no toggle affordance. Rounded
  // pills with the plugin name in body-medium-default / content-default (per
  // the Figma), which PanelItem's lighter/secondary default doesn't match.
  const pluginRows = active.map((plugin) => (
    <div
      key={plugin.name}
      className="flex items-center gap-1 rounded-full py-2 pl-2 pr-2.5"
    >
      <Plug
        aria-hidden
        className="size-4 shrink-0 text-[var(--content-tertiary)]"
      />
      <Typography
        variant="body-medium-default"
        className="truncate text-[var(--content-default)]"
      >
        {plugin.label}
      </Typography>
    </div>
  ));

  const manageFooter = (
    <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
      <Button variant="primary" leftIcon={<Cog />} onClick={handleManage}>
        Manage
      </Button>
      <Typography
        variant="label-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {COST_CAPTION}
      </Typography>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="ghost"
            active
            iconOnly={<Plug />}
            tintColor="var(--content-default)"
            aria-label={ariaLabel}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header>
            <BottomSheet.Title>Plugins</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            {pluginRows}
            {manageFooter}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          active
          leftIcon={<Plug />}
          className="rounded-full"
          tintColor="var(--content-default)"
          aria-label={ariaLabel}
        >
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-60 p-0"
      >
        <div className="px-3 pb-1 pt-3">
          <Typography
            variant="body-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Plugins
          </Typography>
        </div>
        {pluginRows.length > 0 ? (
          <div className="max-h-[240px] overflow-y-auto px-1">{pluginRows}</div>
        ) : null}
        {manageFooter}
      </Popover.Content>
    </Popover.Root>
  );
}
