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
  const user = useAuthStore.use.user();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  // Prefer the account's real name; fall back to username, then email, then
  // the generic label so the trigger is never blank. Matches the display-name
  // derivation used elsewhere (see session-replay-control.ts).
  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
    user?.username ||
    user?.email ||
    "Preferences";

  const trigger =
    triggerVariant === "pill" ? (
      /* Solid surface + shadow: the pill floats over the scrolling
         conversation list, so it can't be transparent like `ghost`. */
      <Button
        variant="ghost"
        leftIcon={<CircleUser />}
        aria-label={displayName}
        title={displayName}
        className="h-10 w-full min-w-0 rounded-full border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 shadow-[var(--shadow-lg)]"
      >
        {/* A long name/email must not force the pill wider and overlap the
            sibling New Chat pill, so truncate the visible label; the full
            value stays available via aria-label/title. */}
        <span className="min-w-0 truncate">{displayName}</span>
      </Button>
    ) : (
      <SideMenu.Item
        icon={CircleUser}
        label={displayName}
        trailingIcon={isOpen ? ChevronDown : ChevronUp}
        active={isOpen}
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
  const showBillingRows =
    billingPlatformGate === "full" && isPlatformHosted && isOrgReady;
  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled: showBillingRows,
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

  return (
    <>
      {showBillingRows && effectiveBalance !== null ? (
        <div className="my-2">
          <CreditsCard
            balance={formatWholeCredits(effectiveBalance)}
            onAddCredits={() => {
              onClose();
              navigate(routes.settings.billing);
            }}
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
