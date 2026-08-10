import {
  ChevronDown,
  ChevronUp,
  CircleUser,
  MessageSquareText,
  Settings as SettingsIcon,
  Shield,
} from "lucide-react";
import { lazy, useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  Button,
  PanelItem,
  Popover,
  SideMenu,
  useSideMenuCollapsed,
} from "@vellumai/design-library";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ThemeToggle } from "@/components/theme-toggle";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import { openUrl } from "@/runtime/browser";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { adminUrl, routes } from "@/utils/routes";

import { CreditsCard } from "./credits-card";

// Modal only opens when the user clicks "Share Feedback" — defer loading
// until then to keep the modal's form deps (markdown editor, etc.) out of
// the initial bundle.
const ShareFeedbackModal = lazy(() =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  })),
);

/**
 * The trigger names the menu it opens, never the signed-in account. This is a
 * settings entry point rather than a profile row, and the account's identity
 * belongs on the Settings page the menu links to.
 */
const PREFERENCES_LABEL = "Preferences";

export interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
  /**
   * Trigger presentation. `item` is the labeled side-menu footer row (rail);
   * `pill` is a floating rounded button for the mobile overlay's action row.
   */
  triggerVariant?: "item" | "pill";
}

export function PreferencesMenu({
  assistantId,
  assistantVersion,
  activeConversationId,
  triggerVariant = "item",
}: PreferencesMenuProps) {
  /* From the menu rather than a prop: this trigger has to reduce to a tile at
     the same moment every other rail entry does, and a threaded prop is that
     one fact derived twice, free to disagree with the menu rendering around
     it. The `pill` variant ignores it, and only renders on the overlay, where
     it reads false regardless. */
  const collapsed = useSideMenuCollapsed();
  const isAuthenticated = useIsAuthenticated();
  const isTouchMobile = useTouchMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger =
    triggerVariant === "pill" ? (
      /* Solid surface + shadow: the pill floats over the scrolling
         conversation list, so it can't be transparent like `ghost`. */
      <Button
        variant="ghost"
        leftIcon={<CircleUser />}
        className="h-10 w-full min-w-0 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 shadow-[var(--shadow-lg)]"
      >
        {/* `truncate` is belt-and-braces: the label is a fixed short string,
            but the pill shares its row with New Chat and must never grow
            wide enough to overlap it at narrow viewports. */}
        <span className="min-w-0 truncate">{PREFERENCES_LABEL}</span>
      </Button>
    ) : collapsed ? (
      /* Collapsed, the same tile every other rail entry reduces to: a circle
         at the pill's own height with the glyph centred and no label, its name
         carried by the hover tooltip. A pill is sized by its content, so one
         keeping its label is wider than the collapsed rail and gets clipped
         mid-word, and one with only the label dropped is still a
         content-width capsule with the glyph against its leading edge.
         `SideMenu.Item` owns that whole treatment, and it is what the pinned
         apps above and the section tiles use, so the foot of the rail is drawn
         by the same component as the rest of it.

         No chevron: it says which way the popover will open, and a tile has
         no room for it beside the glyph. */
      <SideMenu.Item
        icon={CircleUser}
        label={PREFERENCES_LABEL}
        showCollapsedTooltip
        shape="tile"
        active={isOpen}
        /* `active` is the open-popover surface here, not a location: this
           tile opens a menu over the rail rather than navigating, so it drops
           the `aria-current="page"` a real destination row sets. Mirrors the
           section tiles in `CollapsedGroupIcon`. */
        aria-current={undefined}
        aria-haspopup="dialog"
        data-tour-id="settings"
      />
    ) : (
      /* A pill, matching the identity and pinned-app entries it shares the
         rail with: these are destinations you keep, not rows in a list.
         Distinct from `triggerVariant="pill"` above, which is the mobile
         overlay's floating action button. */
      <PanelItem
        shape="pill"
        /* The popover owns the click, so this row takes no handler of its
           own and needs telling that it is still a control. */
        trigger
        icon={CircleUser}
        label={PREFERENCES_LABEL}
        expandChevron={isOpen ? ChevronDown : ChevronUp}
        active={isOpen}
        data-tour-id="settings"
      />
    );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
    />
  );

  return (
    <>
      {isTouchMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content className="max-h-[85dvh]">
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Preferences</BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">{content}</BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      ) : (
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            tabIndex={-1}
            onOpenAutoFocus={(event) => {
              const content = event.currentTarget as HTMLElement | null;
              event.preventDefault();
              content?.focus();
            }}
            className="w-64 rounded-lg p-4"
          >
            {content}
          </Popover.Content>
        </Popover.Root>
      )}

      {isFeedbackOpen ? (
        <LazyBoundary>
          <ShareFeedbackModal
            open={isFeedbackOpen}
            onClose={() => setIsFeedbackOpen(false)}
            assistantId={assistantId}
            assistantVersion={assistantVersion}
            activeConversationId={activeConversationId}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
}

function PreferencesMenuContent({
  onClose,
  onShareFeedback,
}: PreferencesMenuContentProps) {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const platformGate = usePlatformGate();
  const { enabled: showBillingRows, balance: effectiveBalance } =
    useBillingBalanceStatus();
  const isNativeAndroid = useIsNativeAndroid();

  return (
    <>
      <ThemeToggle className="px-2 py-0" />

      <div className="my-2 border-t border-[var(--border-subtle)]" />

      {showBillingRows && effectiveBalance !== null ? (
        <div className="my-2">
          <CreditsCard
            balance={formatWholeCredits(effectiveBalance)}
            onAddCredits={
              isNativeAndroid
                ? undefined
                : () => {
                    onClose();
                    navigate(routes.settings.usageBilling);
                  }
            }
          />
        </div>
      ) : null}

      {(platformGate === "full" || isElectron()) && (
        <PanelItem
          icon={MessageSquareText}
          label="Share Feedback"
          onSelect={() => {
            onClose();
            onShareFeedback();
          }}
        />
      )}

      {user?.isStaff ? (
        <PanelItem
          icon={Shield}
          label="Admin"
          onSelect={() => {
            onClose();
            void openUrl(adminUrl());
          }}
        />
      ) : null}

      {/*
        Settings is intentionally last: the popover anchors side="top", so
        the final item sits closest to the Preferences trigger. Item-level
        ordering can't be asserted by the SSR test harness (open={false}).
      */}
      <PanelItem
        icon={SettingsIcon}
        label="Settings"
        onSelect={() => {
          onClose();
          navigate(routes.settings.root);
        }}
      />
    </>
  );
}

function formatWholeCredits(value: string): string {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) {
    return value;
  }
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
