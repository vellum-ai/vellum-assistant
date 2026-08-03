import { useQuery } from "@tanstack/react-query";
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
} from "@vellumai/design-library";

import { LazyBoundary } from "@/components/lazy-boundary";
import { ThemeToggle } from "@/components/theme-toggle";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
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
  const isAuthenticated = useIsAuthenticated();
  const isMobile = useIsMobile();
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
    ) : (
      <SideMenu.Item
        icon={CircleUser}
        label={PREFERENCES_LABEL}
        trailingIcon={isOpen ? ChevronDown : ChevronUp}
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
      {isMobile ? (
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
  const billingPlatformGate = usePlatformGate({ platformHostedOnly: true });
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isOrgReady = useIsOrgReady();
  const isNativeAndroid = useIsNativeAndroid();
  const showBillingRows =
    billingPlatformGate === "full" && isPlatformHosted && isOrgReady;
  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled: showBillingRows,
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

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
