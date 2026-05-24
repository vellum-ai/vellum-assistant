import { ChevronDown, ChevronRight, CircleAlert, Pin } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { PanelItem, Popover } from "@vellum/design-library";
import {
  formatBackgroundSubGroupLabel,
  groupBackgroundConversationsBySource,
} from "@/domains/chat/utils/background-sub-groups.js";
import {
  isConversationPinned,
  type CustomGroup,
} from "@/domains/chat/utils/group-conversations.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";

/**
 * Collapsed-rail conversations affordance. Renders a small square button
 * showing the total live-conversation count; clicking it opens a popover
 * to the right with every non-empty category (Pinned / Scheduled /
 * Background / Slack / Recents) as a section of `PanelItem` rows.
 *
 * Background additionally sub-groups by `source` (via
 * `groupBackgroundConversationsBySource`) so Heartbeat / Reflections /
 * any custom background source each get their own collapsible row. Empty
 * categories are skipped entirely.
 */

export interface CollapsedConversationsButtonProps {
  pinned: Conversation[];
  scheduled: Conversation[];
  background: Conversation[];
  slack: Conversation[];
  recents: Conversation[];
  /** Custom conversation groups (visible when the conversationGroupsUI flag is on). */
  customGroups?: CustomGroup[];
  activeConversationId?: string;
  onSelectConversation: (conversationId: string) => void;
  /**
   * Optional: build the hover-revealed action menu for a given
   * conversation row. When omitted, rows render without a trailing
   * action. Sharing the same render function keeps behavior identical
   * between the expanded rail and this collapsed popover.
   */
  renderActions?: (conversation: Conversation) => ReactNode;
  /** Set of conversation keys that need user attention (pending approval/secret). */
  attentionConversationIds?: Set<string>;
}

export function CollapsedConversationsButton({
  pinned,
  scheduled,
  background,
  slack,
  recents,
  customGroups,
  activeConversationId,
  onSelectConversation,
  renderActions,
  attentionConversationIds,
}: CollapsedConversationsButtonProps) {
  const [open, setOpen] = useState(false);

  const customGroupCount = customGroups
    ? customGroups.reduce((sum, g) => sum + g.conversations.length, 0)
    : 0;

  const totalCount =
    pinned.length +
    scheduled.length +
    background.length +
    slack.length +
    recents.length +
    customGroupCount;

  // Nothing to show when every bucket is empty — hide the trigger
  // entirely rather than render a "0" badge the user can't act on.
  if (totalCount === 0) {
    return null;
  }

  const hasAttention = attentionConversationIds && attentionConversationIds.size > 0;

  const closeMenu = () => setOpen(false);
  const handleSelect = (conversationId: string) => {
    closeMenu();
    onSelectConversation(conversationId);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${totalCount} conversations${hasAttention ? " — action needed" : ""}`}
          aria-haspopup="dialog"
          className="relative flex h-8 w-8 items-center justify-center rounded-[6px] bg-[var(--surface-base)] text-label-small-default text-[var(--content-tertiary)] transition-colors hover:text-[var(--content-secondary)] aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-emphasised)]"
        >
          {totalCount}
          {hasAttention ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] bg-[var(--system-mid-strong)]"
            />
          ) : null}
        </button>
      </Popover.Trigger>
      <Popover.Content
        side="right"
        align="start"
        sideOffset={8}
        className="max-h-[500px] w-72 overflow-y-auto rounded-lg py-2 px-0"
      >
        {pinned.length > 0 ? (
          <SimpleSection
            title="Pinned"
            conversations={pinned}
            activeConversationId={activeConversationId}
            onSelect={handleSelect}
            renderActions={renderActions}
            attentionConversationIds={attentionConversationIds}
          />
        ) : null}

        {scheduled.length > 0 ? (
          <SimpleSection
            title="Scheduled"
            conversations={scheduled}
            activeConversationId={activeConversationId}
            onSelect={handleSelect}
            renderActions={renderActions}
            attentionConversationIds={attentionConversationIds}
          />
        ) : null}

        {background.length > 0 ? (
          <BackgroundSection
            conversations={background}
            activeConversationId={activeConversationId}
            onSelect={handleSelect}
            renderActions={renderActions}
            attentionConversationIds={attentionConversationIds}
          />
        ) : null}

        {slack.length > 0 ? (
          <SimpleSection
            title="Slack"
            conversations={slack}
            activeConversationId={activeConversationId}
            onSelect={handleSelect}
            renderActions={renderActions}
            attentionConversationIds={attentionConversationIds}
          />
        ) : null}

        {recents.length > 0 ? (
          <SimpleSection
            title="Recents"
            conversations={recents}
            activeConversationId={activeConversationId}
            onSelect={handleSelect}
            renderActions={renderActions}
            attentionConversationIds={attentionConversationIds}
          />
        ) : null}

        {customGroups?.map((group) =>
          group.conversations.length > 0 ? (
            <SimpleSection
              key={group.id}
              title={group.name}
              conversations={group.conversations}
              activeConversationId={activeConversationId}
              onSelect={handleSelect}
              renderActions={renderActions}
              attentionConversationIds={attentionConversationIds}
            />
          ) : null,
        )}
      </Popover.Content>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface SectionHeaderProps {
  title: string;
  count: number;
}

function SectionHeader({ title, count }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-1">
      <span className="text-body-small-default text-[var(--content-tertiary)]">
        {title}
      </span>
      <span className="text-body-small-default text-[var(--content-tertiary)]">
        {count}
      </span>
    </div>
  );
}

interface SimpleSectionProps {
  title: string;
  conversations: Conversation[];
  activeConversationId?: string;
  onSelect: (conversationId: string) => void;
  renderActions?: (conversation: Conversation) => ReactNode;
  attentionConversationIds?: Set<string>;
}

/**
 * Flat section — header + `PanelItem` per conversation. Used for every
 * bucket except Background (which has sub-group sub-rows).
 */
function SimpleSection({
  title,
  conversations,
  activeConversationId,
  onSelect,
  renderActions,
  attentionConversationIds,
}: SimpleSectionProps) {
  return (
    <div className="pb-1">
      <SectionHeader title={title} count={conversations.length} />
      <div className="px-2">
        {conversations.map((c) => {
          const needsAttention = attentionConversationIds?.has(c.conversationId) ?? false;
          return (
            <PanelItem
              key={c.conversationId}
              icon={needsAttention ? CircleAlert : isConversationPinned(c) ? Pin : undefined}
              label={c.title ?? "Untitled"}
              active={c.conversationId === activeConversationId}
              onSelect={() => onSelect(c.conversationId)}
              trailingAction={renderActions?.(c)}
              className={needsAttention ? "text-[var(--system-mid-strong)]" : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}

interface BackgroundSectionProps {
  conversations: Conversation[];
  activeConversationId?: string;
  onSelect: (conversationId: string) => void;
  renderActions?: (conversation: Conversation) => ReactNode;
  attentionConversationIds?: Set<string>;
}

/**
 * Background section with source sub-grouping. Each group with >1
 * conversation gets a collapsible header row (`PanelItem` with an
 * expand chevron as its icon). Sources with a single conversation flatten
 * into a single leaf row.
 */
function BackgroundSection({
  conversations,
  activeConversationId,
  onSelect,
  renderActions,
  attentionConversationIds,
}: BackgroundSectionProps) {
  const subGroups = useMemo(() => groupBackgroundConversationsBySource(conversations), [conversations]);
  const [manualExpandedKeys, setManualExpandedKeys] = useState<Set<string>>(new Set());

  const attentionExpandedKeys = useMemo(() => {
    if (!attentionConversationIds || attentionConversationIds.size === 0) return new Set<string>();
    const keys = new Set<string>();
    for (const group of subGroups) {
      if (group.key.startsWith("__single__:")) continue;
      if (group.conversations.some(c => attentionConversationIds.has(c.conversationId))) {
        keys.add(group.key);
      }
    }
    return keys;
  }, [attentionConversationIds, subGroups]);

  const expandedKeys = useMemo(() => {
    if (attentionExpandedKeys.size === 0) return manualExpandedKeys;
    const merged = new Set(manualExpandedKeys);
    for (const k of attentionExpandedKeys) merged.add(k);
    return merged;
  }, [manualExpandedKeys, attentionExpandedKeys]);

  const toggleGroup = (key: string) => {
    setManualExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="pb-1">
      <SectionHeader title="Background" count={conversations.length} />
      <div className="px-2">
        {subGroups.map((group) => {
          // `__single__:` prefix comes from backgroundSubGroups for
          // conversations that have no `source` value — render them as a
          // flat leaf row with no grouping header.
          const isSingle = group.key.startsWith("__single__:");
          if (isSingle) {
            const c = group.conversations[0];
            if (!c) return null;
            const singleNeedsAttention = attentionConversationIds?.has(c.conversationId) ?? false;
            return (
              <PanelItem
                key={c.conversationId}
                icon={singleNeedsAttention ? CircleAlert : isConversationPinned(c) ? Pin : undefined}
                label={c.title ?? "Untitled"}
                active={c.conversationId === activeConversationId}
                onSelect={() => onSelect(c.conversationId)}
                trailingAction={renderActions?.(c)}
                className={singleNeedsAttention ? "text-[var(--system-mid-strong)]" : undefined}
              />
            );
          }

          const isExpanded = expandedKeys.has(group.key);
          return (
            <div key={group.key}>
              <PanelItem
                icon={isExpanded ? ChevronDown : ChevronRight}
                label={formatBackgroundSubGroupLabel(group.key)}
                badge={group.conversations.length}
                onSelect={() => toggleGroup(group.key)}
              />
              {isExpanded
                ? group.conversations.map((c) => {
                    const rowNeedsAttention = attentionConversationIds?.has(c.conversationId) ?? false;
                    return (
                      <PanelItem
                        key={c.conversationId}
                        icon={rowNeedsAttention ? CircleAlert : isConversationPinned(c) ? Pin : undefined}
                        label={c.title ?? "Untitled"}
                        active={c.conversationId === activeConversationId}
                        onSelect={() => onSelect(c.conversationId)}
                        trailingAction={renderActions?.(c)}
                        className={rowNeedsAttention ? "text-[var(--system-mid-strong)]" : undefined}
                      />
                    );
                  })
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
