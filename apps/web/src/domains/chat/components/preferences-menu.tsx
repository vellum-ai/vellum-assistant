import { useQuery } from "@tanstack/react-query";
import {
  ChartColumn,
  ChevronDown,
  ChevronUp,
  Gift,
  LogOut,
  MessageSquareText,
  Settings as SettingsIcon,
  Shield,
  SlidersHorizontal,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  Button,
  PanelItem,
  Popover,
  SideMenu,
} from "@vellum/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/app.js";
import { useAuthStore } from "@/stores/auth-store.js";
import { routes } from "@/utils/routes.js";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { ShareFeedbackModal } from "@/components/share-feedback-modal.js";
import { EarnCreditsModal } from "@/components/earn-credits-modal.js";
import { ThemeToggle } from "@/components/theme-toggle.js";

/**
 * Preferences menu rendered inside the assistant sidebar footer.
 *
 * Owns both its trigger (a `SideMenu.Item` labelled "Preferences") and
 * its popover content. The trigger flips to its active state while the
 * popover is open and its chevron swaps from Up → Down to signal the
 * expansion direction (popover opens *above* the trigger since it's
 * pinned to the bottom of the rail).
 *
 * Content mirrors `UserMenu`'s dropdown — Theme, Credits, Earn credits,
 * Settings, Usage, Share Feedback, Admin, Log Out — but rendered
 * with `PanelItem` for every row except the two custom ones (Theme
 * toggle group + Credits / Add credits row). Those two have bespoke
 * layout that doesn't map onto a generic icon + label + badge row.
 *
 * **Mobile parity**: when `useIsMobile()` is true, the same content is
 * rendered inside a `BottomSheet` (Radix Dialog) so it slides up from the
 * bottom edge full-width. Desktop keeps the existing `Popover` behavior.
 */
export interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
}

export function PreferencesMenu({
  assistantId,
  assistantVersion,
}: PreferencesMenuProps) {
  const isLoggedIn = useAuthStore.use.isLoggedIn();
  const isMobile = useIsMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isEarnCreditsOpen, setIsEarnCreditsOpen] = useState(false);

  if (!isLoggedIn) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger = (
    <SideMenu.Item
      icon={SlidersHorizontal}
      label="Preferences"
      trailingIcon={isOpen ? ChevronDown : ChevronUp}
      active={isOpen}
    />
  );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
      onEarnCredits={() => setIsEarnCreditsOpen(true)}
    />
  );

  return (
    <>
      {isMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content>
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
            className="w-64 rounded-lg p-4"
          >
            {content}
          </Popover.Content>
        </Popover.Root>
      )}

      <ShareFeedbackModal
        open={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        assistantId={assistantId}
        assistantVersion={assistantVersion}
      />

      <EarnCreditsModal
        open={isEarnCreditsOpen}
        onClose={() => setIsEarnCreditsOpen(false)}
      />
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
  onEarnCredits: () => void;
}

function PreferencesMenuContent({
  onClose,
  onShareFeedback,
  onEarnCredits,
}: PreferencesMenuContentProps) {
  const navigate = useNavigate();
  const user = useAuthStore.use.user();
  const logout = useAuthStore.use.logout();
  const { referralCodes } = useAppFeatureFlags();

  const isAdmin = user?.isStaff ?? false;

  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

  return (
    <>
      <ThemeToggle className="px-2 pt-0" />

      <MenuDivider />

      {effectiveBalance !== null ? (
        <>
          <div className="flex items-center justify-between gap-3 py-2 pl-[8px]">
            <span
              className="text-body-medium-lighter"
              style={{ color: "var(--content-default)" }}
            >
              {formatWholeCredits(effectiveBalance)} credits
            </span>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => {
                onClose();
                navigate(routes.settings.billing);
              }}
            >
              Add credits
            </Button>
          </div>
          <MenuDivider />
        </>
      ) : null}

      {referralCodes ? (
        <>
          <PanelItem
            icon={Gift}
            label="Earn credits"
            onSelect={() => {
              onClose();
              onEarnCredits();
            }}
          />
          <MenuDivider />
        </>
      ) : null}

      <PanelItem
        icon={SettingsIcon}
        label="Settings"
        onSelect={() => {
          onClose();
          navigate(routes.settings.root);
        }}
      />

      <PanelItem
        icon={ChartColumn}
        label="Usage"
        onSelect={() => {
          onClose();
          navigate(routes.logs.usage);
        }}
      />

      <PanelItem
        icon={MessageSquareText}
        label="Share Feedback"
        onSelect={() => {
          onClose();
          onShareFeedback();
        }}
      />

      {isAdmin ? (
        <PanelItem
          icon={Shield}
          label="Admin"
          onSelect={() => {
            onClose();
            navigate(routes.admin.root);
          }}
        />
      ) : null}

      <PanelItem
        icon={LogOut}
        label="Log Out"
        onSelect={async () => {
          await logout();
          onClose();
          navigate(routes.account.login);
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

function MenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="my-1 h-px"
      style={{ background: "var(--border-overlay)" }}
    />
  );
}
