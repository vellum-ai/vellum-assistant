
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
import { useNavigate } from "react-router";
import { useState } from "react";

import { BottomSheet } from "@vellum/design-library/components/bottom-sheet";
import { Button } from "@vellum/design-library/components/button";
import { PanelItem } from "@/components/app/core/PanelItem/PanelItem.js";
import { Popover } from "@vellum/design-library/components/popover";
import { SideMenu } from "@/components/app/core/SideMenu/SideMenu.js";
import { ShareFeedbackModal } from "@/components/shared/ShareFeedbackModal/index.js";
import { EarnCreditsModal } from "@/components/shared/UserMenu/EarnCreditsModal.js";
import { ThemeToggle } from "@/components/shared/UserMenu/UserMenu.js";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAuth } from "@/lib/auth.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { useIsMobile } from "@/lib/hooks/useIsMobile.js";
import { routes } from "@/lib/routes.js";

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
 * bottom edge full-width per the macOS Figma mobile pattern. Desktop
 * keeps the existing `Popover` behavior.
 */
interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
}

export function PreferencesMenu({ assistantId, assistantVersion }: PreferencesMenuProps) {
  const { isLoggedIn } = useAuth();
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
      // SideMenu.Item only renders as a <button> when `onSelect` is
      // defined — the noop here just opts into button semantics so
      // Radix's `asChild` has a ref to attach. Radix composes its
      // own click handler on top to toggle the surface.
      onSelect={() => undefined}
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
            {/* Radix Dialog requires a Title for screen-reader accessibility.
                The Figma surface (node 3272:40182) has no visible title, so
                we render a visually-hidden one — matches the convention
                shown in BottomSheet.gallery.tsx → "NoTitle" example. */}
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>Preferences</BottomSheet.Title>
            </BottomSheet.Header>
            {/* Wrap in Body so the menu scrolls when it hits the sheet's
                50dvh cap. `pt-0` because the Header above is sr-only and
                the sheet's own pt-4 already supplies the top gutter. */}
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

/**
 * The shared body of `PreferencesMenu` — the same JSX renders inside a
 * desktop `Popover.Content` (constrained to `w-64`) or a mobile
 * `BottomSheet.Content` (full viewport width). `PanelItem` rows are
 * already `w-full`, so the layout adapts without per-surface tweaks.
 *
 * Reads the `useAuth`, `useAppFeatureFlags`, `useRouter`, and billing-summary
 * `useQuery` hooks directly so the parent only has to pass the three
 * surface-control callbacks (`onClose` and the two modal openers).
 */
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
  const { isAdmin, logout } = useAuth();
  const { referralCodes } = useAppFeatureFlags();

  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

  return (
    <>
      {/* Theme — custom row (not a PanelItem). 8px horizontal padding
          aligns the row with PanelItem's internal padding so labels line
          up; pt-0 lets the outer menu's 16px top padding own the spacing
          above the row. */}
      <ThemeToggle className="px-2 pt-0" />

      <MenuDivider />

      {/* Credits — custom row (not a PanelItem). 8px left padding aligns
          the label with the icon column of the PanelItem rows below. */}
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

      {/* All remaining rows use PanelItem per the redesign. The outer menu
          container provides 16px horizontal padding so PanelItem rows sit
          flush against that gutter without per-section wrappers. */}
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

/**
 * 1px divider with 4px top + bottom margin so adjacent menu rows breathe
 * away from the line. Spans the full width of the menu's content box;
 * the outer menu container supplies the 16px horizontal padding.
 */
function MenuDivider() {
  return (
    <div
      aria-hidden="true"
      className="my-1 h-px"
      style={{ background: "var(--border-overlay)" }}
    />
  );
}
