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
import type { PreferencesUsage } from "@/domains/chat/hooks/use-preferences-usage";
import { usePreferencesUsage } from "@/domains/chat/hooks/use-preferences-usage";
import { useBillingBalanceStatus } from "@/hooks/use-billing-balance-status";
import { useObscureCredits } from "@/hooks/use-obscure-credits-flag";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { displayedCreditsUsd } from "@/lib/billing/displayed-credits";
import { isElectron } from "@/runtime/is-electron";
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import { openUrl } from "@/runtime/browser";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { adminUrl, routes } from "@/utils/routes";

import { CreditsCard } from "./credits-card";
import { PreferencesUsagePanel } from "./preferences-usage-panel";
import { useTranslation } from "@/i18n";

// Modal only opens when the user clicks "Share Feedback" — defer loading
// until then to keep the modal's form deps (markdown editor, etc.) out of
// the initial bundle.
const ShareFeedbackModal = lazy(() =>
  import("@/components/share-feedback-modal").then((m) => ({
    default: m.ShareFeedbackModal,
  })),
);

// Same treatment for the top-up checkout, which only the usage panel's
// exhausted strip opens.
const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);

/**
 * The trigger names the menu it opens, never the signed-in account. This is a
 * settings entry point rather than a profile row, and the account's identity
 * belongs on the Settings page the menu links to.
 */

/**
 * Whether the credits row belongs below the usage panel.
 *
 * Under `obscure-credits` the dollar balance stays hidden while the included
 * bundle still has room: the bar is the reading that matters there, and a
 * second number beside it only invites the arithmetic the flag exists to
 * avoid. Once the bundle is spent the next turn draws on the wallet instead,
 * so the row that names it comes back, unless the wallet is empty too and the
 * panel's add-credits strip is already saying so.
 *
 * With no reading to hide behind, the row stays: the panel renders nothing
 * without one, and hiding the row too would leave the menu with no balance and
 * no way to buy more. With the flag off the row is whatever it has always
 * been.
 */
export function showsMenuCredits(
  obscureCredits: boolean,
  usage: PreferencesUsage | null,
): boolean {
  if (!obscureCredits || usage == null) {
    return true;
  }
  return usage.spent && !usage.exhausted;
}

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
  const { t } = useTranslation("chat");
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
  /* Held here rather than in the menu body: the popover and the bottom sheet
     both unmount their content on close, and the strip closes the menu as it
     opens the checkout. */
  const [isAddCreditsOpen, setIsAddCreditsOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger =
    triggerVariant === "pill" ? (
      /* Solid surface: the pill floats over the scrolling conversation list,
         so it can't be transparent like `ghost`. */
      <Button
        variant="ghost"
        leftIcon={<CircleUser />}
        className="min-h-[var(--side-menu-tile-size,36px)] min-w-0 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] px-3"
      >
        {/* `truncate` is belt-and-braces: the label is a fixed short string,
            but the pill shares its row with New Chat and must never grow
            wide enough to overlap it at narrow viewports. */}
        <span className="min-w-0 truncate">{t("preferencesMenu.preferences")}</span>
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
        label={t("preferencesMenu.preferences")}
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
        label={t("preferencesMenu.preferences")}
        expandChevron={isOpen ? ChevronDown : ChevronUp}
        active={isOpen}
        data-tour-id="settings"
      />
    );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
      onAddCredits={() => setIsAddCreditsOpen(true)}
      activeConversationId={activeConversationId}
    />
  );

  return (
    <>
      {isTouchMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content className="max-h-[85dvh]">
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>{t("preferencesMenu.preferences")}</BottomSheet.Title>
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

      {isAddCreditsOpen ? (
        <LazyBoundary>
          <AddCreditsModal
            open={isAddCreditsOpen}
            onOpenChange={setIsAddCreditsOpen}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
  onAddCredits: () => void;
  activeConversationId?: string | null;
}

function PreferencesMenuContent({
  onClose,
  onShareFeedback,
  onAddCredits,
  activeConversationId,
}: PreferencesMenuContentProps) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const platformGate = usePlatformGate();
  const {
    enabled: showBillingRows,
    balance: effectiveBalance,
    availableUsageBalance,
  } = useBillingBalanceStatus();
  const isNativeAndroid = useIsNativeAndroid();
  /* The same reading the usage panel below draws, composed once so the row and
     the bar can never disagree about how much of the bundle is left. */
  const obscureCredits = useObscureCredits();
  const usage = usePreferencesUsage({ conversationId: activeConversationId });
  const showCredits = showsMenuCredits(obscureCredits, usage);

  return (
    <>
      <ThemeToggle className="px-2 py-0" />

      <div className="my-2 border-t border-[var(--border-subtle)]" />

      <PreferencesUsagePanel
        conversationId={activeConversationId}
        onOpenBilling={() => {
          onClose();
          navigate(routes.settings.usageBilling);
        }}
        onAddCredits={
          isNativeAndroid
            ? undefined
            : () => {
                onClose();
                onAddCredits();
              }
        }
      />

      {showBillingRows && effectiveBalance !== null && showCredits ? (
        <div className="my-2">
          <CreditsCard
            balance={formatWholeCredits(
              displayedCreditsUsd(
                obscureCredits,
                effectiveBalance,
                availableUsageBalance,
              ),
            )}
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
          label={t("preferencesMenu.shareFeedback")}
          onSelect={() => {
            onClose();
            onShareFeedback();
          }}
        />
      )}

      {user?.isStaff ? (
        <PanelItem
          icon={Shield}
          label={t("preferencesMenu.admin")}
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
        label={t("preferencesMenu.settings")}
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
