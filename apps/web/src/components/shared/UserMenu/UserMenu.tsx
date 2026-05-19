
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChartColumn,
  Gift,
  Heart,
  LogOut,
  MessageSquareText,
  Monitor,
  Moon,
  Settings,
  Shield,
  Sun,
  User,
} from "lucide-react";
import { AppLink as Link } from "@/adapters/app-link.js";
import { useNavigate, useLocation } from "react-router";
import { useEffect, useState, type ReactNode } from "react";

import { Popover } from "@vellum/design-library/components/popover";
import { SegmentControl } from "@vellum/design-library/components/segment-control";
import { cn } from "@vellum/design-library/utils/cn";
import { ShareFeedbackModal } from "@/components/shared/ShareFeedbackModal/index.js";
import { EarnCreditsModal } from "@/components/shared/UserMenu/EarnCreditsModal.js";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAuth } from "@/lib/auth.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";
import { SignInButton } from "@/components/shared/SignInButton.js";
import {
  applyThemePreference,
  normalizeThemePreference,
  readStoredThemePreference,
  type ThemePreference,
  writeStoredThemePreference,
} from "@/lib/theme-preferences.js";

const BASE_THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
}> = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

const VELVET_THEME_OPTION = {
  value: "velvet",
  label: "Velvet",
  Icon: Heart,
} satisfies {
  value: ThemePreference;
  label: string;
  Icon: typeof Monitor;
};

// Shared classes for the user-menu rows (Earn credits, Assistant, Settings, …).
// Mobile bumps to body-large-default (16/500/100) + 12px py so each row hits
// a ~40px tap target, matching the side-menu rows and icon buttons elsewhere.
const MENU_ROW_CLASSES =
  "flex items-center gap-3 px-4 py-2 max-md:py-3 text-body-medium-lighter max-md:text-body-large-default transition-colors hover:opacity-80";

export function ThemeToggle({ className }: { className?: string } = {}) {
  const { velvet } = useAppFeatureFlags();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  useEffect(() => {
    const handleExternalThemeChange = (event: CustomEvent<string>) => {
      setTheme(
        normalizeThemePreference(event.detail, { velvetEnabled: velvet }),
      );
    };
    window.addEventListener(
      "vellumThemeChange",
      handleExternalThemeChange as EventListener,
    );
    return () =>
      window.removeEventListener(
        "vellumThemeChange",
        handleExternalThemeChange as EventListener,
      );
  }, [velvet]);

  const handleChange = (next: ThemePreference) => {
    setTheme(next);
    writeStoredThemePreference(next);
    applyThemePreference(next);
  };

  const themeOptions = velvet
    ? [...BASE_THEME_OPTIONS, VELVET_THEME_OPTION]
    : BASE_THEME_OPTIONS;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-4 py-2 max-md:py-3",
        className,
      )}
    >
      <span
        className="text-body-small-default max-md:text-body-large-default"
        style={{ color: "var(--content-secondary)" }}
      >
        Theme
      </span>
      <SegmentControl<ThemePreference>
        ariaLabel="Theme"
        value={theme}
        onChange={handleChange}
        iconOnly
        items={themeOptions.map(({ value, label, Icon }) => ({
          value,
          label,
          icon: <Icon className="h-3.5 w-3.5 max-md:h-4 max-md:w-4" />,
        }))}
      />
    </div>
  );
}

/**
 * Format a decimal-string credit amount for compact display inside the user
 * menu. Strips a trailing ".00" so whole-number balances render as "412"
 * rather than "412.00". Matches the macOS drawer's `{balance} credits` row.
 */
export function formatBalance(value: string): string {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) {
    return value;
  }
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return num < 0 ? `-${stripped}` : stripped;
}

type PopoverSide = "top" | "right" | "bottom" | "left";
type PopoverAlign = "start" | "center" | "end";

export interface UserMenuProps {
  /**
   * Override the default 36px avatar trigger with a custom element. The
   * element is wrapped in Radix `Popover.Trigger asChild`, so it must
   * forward its ref (native `button`, `a`, or a `forwardRef` component).
   * When omitted, the avatar button is rendered as before.
   */
  trigger?: ReactNode;
  /**
   * Position props forwarded to `Popover.Content`. Defaults reproduce the
   * original topbar behavior: popover opens downward (`bottom`) and is
   * right-aligned (`end`) with 8px sideOffset.
   */
  side?: PopoverSide;
  align?: PopoverAlign;
  sideOffset?: number;
}

export function UserMenu({
  trigger,
  side = "bottom",
  align = "end",
  sideOffset = 8,
}: UserMenuProps = {}) {
  const navigate = useNavigate();
  const { pathname: pathname } = useLocation();
  const { isLoggedIn, isAdmin, username, logout } = useAuth();
  const { referralCodes } = useAppFeatureFlags();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [isEarnCreditsOpen, setIsEarnCreditsOpen] = useState(false);

  const showCreditsSection = isLoggedIn;
  const { data: billingSummary } = useQuery({
    ...organizationsBillingSummaryRetrieveOptions(),
    enabled: showCreditsSection,
  });
  const effectiveBalance = billingSummary?.effective_balance ?? null;

  if (!isLoggedIn) {
    return (
      <SignInButton
        returnTo={pathname}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-body-medium-default !no-underline transition-colors hover:opacity-80"
        style={{ color: "var(--content-secondary)" }}
      />
    );
  }

  // Default avatar trigger. Sizing lives on the <button> itself (no
  // wrapper div) so Radix `Popover.Trigger asChild` attaches its ref /
  // aria-expanded / aria-haspopup to a natively-focusable element.
  // Wrapping in a <div> broke focus-return on close and produced
  // invalid ARIA attributes on a non-interactive element.
  const defaultTrigger = (
    <button
      type="button"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-body-medium-default transition-colors"
      style={{
        background: "var(--surface-base)",
        color: "var(--content-secondary)",
      }}
      aria-label="User menu"
    >
      {username ? username.charAt(0).toUpperCase() : <User className="h-4 w-4" />}
    </button>
  );

  const triggerElement = trigger ?? defaultTrigger;

  return (
    <>
      <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger asChild>{triggerElement}</Popover.Trigger>
          <Popover.Content
            side={side}
            align={align}
            sideOffset={sideOffset}
            className="w-56 rounded-lg py-1 px-0"
          >
            <ThemeToggle />

            <div
              aria-hidden="true"
              className="mx-4 my-1 h-px"
              style={{ background: "var(--border-overlay)" }}
            />

            {showCreditsSection && effectiveBalance !== null && (
              <div className="flex items-center justify-between gap-3 px-4 py-2 max-md:py-3">
                <span
                  className="text-body-medium-default max-md:text-body-large-default"
                  style={{ color: "var(--content-default)" }}
                >
                  {formatBalance(effectiveBalance)} credits
                </span>
                <Link
                  href={routes.settings.billing}
                  onClick={() => setIsOpen(false)}
                  className="text-body-medium-lighter max-md:text-body-large-default !no-underline transition-colors hover:opacity-80"
                  style={{ color: "var(--content-secondary)" }}
                >
                  Add credits
                </Link>
              </div>
            )}

            {showCreditsSection && effectiveBalance !== null && (
              <div
                aria-hidden="true"
                className="mx-4 my-1 h-px"
                style={{ background: "var(--border-overlay)" }}
              />
            )}

            {showCreditsSection && effectiveBalance !== null && referralCodes && (
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setIsEarnCreditsOpen(true);
                }}
                className={cn(MENU_ROW_CLASSES, "w-full")}
                style={{ color: "var(--content-secondary)" }}
              >
                <Gift className="h-4 w-4" />
                Earn credits
              </button>
            )}

            {showCreditsSection && effectiveBalance !== null && referralCodes && (
              <div
                aria-hidden="true"
                className="mx-4 my-1 h-px"
                style={{ background: "var(--border-overlay)" }}
              />
            )}

            <Link
              href={routes.assistant}
              onClick={() => setIsOpen(false)}
              className={cn(MENU_ROW_CLASSES, "!no-underline")}
              style={{ color: "var(--content-secondary)" }}
            >
              <Bot className="h-4 w-4" />
              Assistant
            </Link>

            <Link
              href={routes.logs.usage}
              onClick={() => setIsOpen(false)}
              className={cn(MENU_ROW_CLASSES, "!no-underline")}
              style={{ color: "var(--content-secondary)" }}
            >
              <ChartColumn className="h-4 w-4" />
              Usage
            </Link>

            <Link
              href={routes.settings.root}
              onClick={() => setIsOpen(false)}
              className={cn(MENU_ROW_CLASSES, "!no-underline")}
              style={{ color: "var(--content-secondary)" }}
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsFeedbackOpen(true);
              }}
              className={cn(MENU_ROW_CLASSES, "w-full")}
              style={{ color: "var(--content-secondary)" }}
            >
              <MessageSquareText className="h-4 w-4" />
              Share Feedback
            </button>

            {isAdmin && (
              <Link
                href={routes.admin.root}
                onClick={() => setIsOpen(false)}
                className={cn(MENU_ROW_CLASSES, "!no-underline")}
                style={{ color: "var(--content-secondary)" }}
              >
                <Shield className="h-4 w-4" />
                Admin
              </Link>
            )}

            <div style={{ borderTop: "1px solid var(--border-base)" }}>
              <button
                onClick={async () => {
                  await logout();
                  setIsOpen(false);
                  navigate(routes.account.login);
                }}
                className={cn(MENU_ROW_CLASSES, "w-full")}
                style={{ color: "var(--content-secondary)" }}
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          </Popover.Content>
        </Popover.Root>

      <ShareFeedbackModal
        open={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
      />

      <EarnCreditsModal
        open={isEarnCreditsOpen}
        onClose={() => setIsEarnCreditsOpen(false)}
      />
    </>
  );
}
