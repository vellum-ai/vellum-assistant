import { type ReactNode } from "react";
import { Link } from "react-router";

import { OnboardingLayout } from "@/components/onboarding-layout";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { useTranslation } from "@/i18n";
import { isElectron } from "@/runtime/is-electron";
import { Button } from "@vellumai/design-library/components/button";

/**
 * The way off the welcome screen that isn't logging in. Local onboarding
 * offers a route past the account entirely ("Continue without account");
 * the platform's `/account/login` offers signup, which is a real navigation
 * and so carries an `href` rather than a handler.
 */
export type WelcomeSecondaryAction =
  | { label: string; onSelect: () => void; href?: never }
  | { label: string; href: string; onSelect?: never };

/**
 * Chrome for the welcome screen on its own: the onboarding layout beside the
 * avatar wave, with the content column the screen centres its copy in.
 *
 * Exported so a surface that has to hold this screen's place before it can
 * render — `/account/login` waiting out the session probe — occupies the same
 * layout instead of flashing a differently-shaped shell first.
 */
export function WelcomeScreenShell({
  children,
  animateAvatarWaveIn = false,
  fillsViewport = false,
}: {
  children: ReactNode;
  animateAvatarWaveIn?: boolean;
  /**
   * Establish the viewport-height box `OnboardingLayout` sizes against.
   *
   * The layout is `h-full`, which fills `RootLayout`'s own `100dvh` shell —
   * what every `/assistant` route renders inside, onboarding included. The
   * `/account` routes have no such shell (`AccountLayout` renders a bare
   * outlet, each screen sizing itself), so there `h-full` has nothing to
   * resolve against and the screen collapses to the height of its copy,
   * clipping the avatar wave to a sliver. Set this on those routes only:
   * doubling the height up inside `RootLayout` would overflow the insets it
   * subtracts for the keyboard and the safe area.
   */
  fillsViewport?: boolean;
}) {
  const content = (
    <OnboardingLayout avatarWave="around" animateAvatarWaveIn={animateAvatarWaveIn}>
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center px-6 pb-40 text-[var(--content-default)] md:pb-0">
        <div className="flex flex-1 flex-col items-center justify-center">
          {children}
        </div>
      </div>
    </OnboardingLayout>
  );

  return fillsViewport ? <div className="h-dvh">{content}</div> : content;
}

/**
 * The screen a visit that has not signed in yet starts on, shared by the two
 * front doors that offer it: `/assistant/welcome` (local clients) and
 * `/account/login` (the platform). Both put the same log-in button on screen
 * and differ only in what they offer beside it, so the copy, the layout, and
 * the OAuth handoff live here once rather than drifting apart in two places.
 *
 * The copy stays in the `onboarding` catalog — one set of strings, so the two
 * screens can't say different things.
 */
export function AuthWelcomeScreen({
  returnTo,
  secondary,
  errorContext,
  fillsViewport = false,
}: {
  /**
   * Where to land after signing in. Omit to derive it from the current route
   * (the onboarding funnel's own rule); pass `null` for a visit that carries
   * no destination, which leaves the post-auth fallback to decide.
   */
  returnTo?: string | null;
  secondary: WelcomeSecondaryAction;
  /** Sentry `context` tag for a failed handoff. */
  errorContext?: string;
  /** See `WelcomeScreenShell` — set on routes outside `RootLayout`'s shell. */
  fillsViewport?: boolean;
}) {
  const { t } = useTranslation("onboarding");
  const { loading, error, login, cancel } = useOnboardingLogin(returnTo, {
    errorContext,
  });

  // Only the desktop shell keeps this screen up while the login runs: it hands
  // off to the system browser and waits for the deep link back. Every other
  // path navigates the page to the provider (`startProviderRedirect`, or the
  // loopback redirect in standalone local mode), so the screen is on its way
  // out and `cancel()` — which only reaches the Electron main process — has
  // nothing to stop. Offering Cancel there just flickers the button on its way
  // off screen; the button still goes inert so a second click can't open a
  // second flow.
  const cancellable = isElectron();
  const awaitingRedirect = loading && !cancellable;

  // Leaving the screen mid-login would strand the OAuth window (and, on
  // Electron, the main process's pending flow) behind us, so the secondary
  // action cancels first whichever way it leaves.
  const handleSecondary = () => {
    if (loading) {
      cancel();
    }
    secondary.onSelect?.();
  };

  const SECONDARY_CLASS = "h-11 text-base";
  const secondaryButton = secondary.href ? (
    <Button
      variant="ghost"
      size="regular"
      fullWidth
      className={SECONDARY_CLASS}
      asChild
    >
      <Link to={secondary.href} onClick={handleSecondary}>
        {secondary.label}
      </Link>
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="regular"
      fullWidth
      className={SECONDARY_CLASS}
      onClick={handleSecondary}
    >
      {secondary.label}
    </Button>
  );

  return (
    <WelcomeScreenShell animateAvatarWaveIn fillsViewport={fillsViewport}>
      {/*
        Only the tablet split is tight enough to wrap the heading: the
        column is widest on the single-column layout, and wide again once
        the wave settles at half width.
      */}
      <h1
        className="text-5xl font-normal tracking-tight md:text-4xl lg:text-5xl xl:text-6xl"
        style={{
          fontFamily: "var(--font-serif)",
          animation: "fadeInUp 0.5s ease-out 0.1s both",
        }}
      >
        {t("welcome.title")}
      </h1>
      <p
        className="mt-3 text-body-large-lighter text-[var(--content-tertiary)]"
        style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
      >
        {t("welcome.body")}
      </p>

      {error && (
        <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
          {error}
        </p>
      )}

      {/*
        A failed handoff is the one thing that grows this column, and the wrap
        composition has about a button's worth of room under it on a 640-tall
        phone before the returning crowd. Spend the gap above the buttons on
        the message rather than adding to the column: the error sits next to
        what it is about either way, and the buttons stay clear of the crowd
        through a message long enough to wrap three times.
      */}
      <div
        className={`${error ? "mt-4" : "mt-15"} flex w-full max-w-sm flex-col gap-3`}
        style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
      >
        <Button
          variant="primary"
          size="regular"
          fullWidth
          className="h-11 text-base"
          disabled={awaitingRedirect}
          onClick={loading && cancellable ? cancel : () => void login()}
        >
          {loading && cancellable ? t("actions.cancel") : t("actions.logIn")}
        </Button>
        {secondaryButton}
      </div>
    </WelcomeScreenShell>
  );
}
