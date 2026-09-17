import {
  ChevronDown,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { ReactNode } from "react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { SplitButton } from "@vellumai/design-library/components/split-button";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { useTranslation } from "@/i18n";

import {
  connectMethodMenuItems,
  useConnectMethodLabel,
} from "../connect-method-display";
import {
  connectableMethods,
  isMcpMethodKind,
  planMethods,
  type ConnectMethod,
  type ConnectMethodKind,
  type ConnectPlan,
} from "../connect-plan";

import {
  INTEGRATION_ACTION_SIZING,
  IntegrationListRow,
  type IntegrationListLayout,
} from "./integration-list-row";

/**
 * Where a connect attempt for this integration has got to.
 *
 * The tile owns none of it: the page starts the attempt and hands the phase
 * back down, so the same tile documents every step in Storybook.
 */
export type TileConnectState =
  | { phase: "idle" }
  /** The provider's sign-in is open in the browser, waiting on the user. */
  | { phase: "waiting"; canCancel: boolean }
  /** The grant landed and the connection is coming up. */
  | { phase: "connecting" }
  | {
      phase: "failed";
      /** The provider's own words. Shown only while they stay one line. */
      error: string;
      /**
       * The method that failed. "Try another way" offers every other method
       * still open to the plan, so the way out of a failed alternative
       * includes the recommended path the user skipped to get here.
       */
      methodId: string;
      methodKind: ConnectMethodKind;
      setupGuideUrl?: string;
    };

export interface IntegrationTileProps {
  plan: ConnectPlan;
  state: TileConnectState;
  layout?: IntegrationListLayout;
  /**
   * Puts a chevron beside the connect action for the other ways in. For a
   * self-hosted assistant, where the choice between the provider's server,
   * Vellum's hosted sign-in, and your own OAuth app is a real one the user is
   * expected to make, so a caller reads it from
   * `useActiveAssistantIsSelfHosted()` (`@/hooks/use-platform-gate`). With one
   * method there is nothing to choose, so the button stays plain whatever
   * this says.
   */
  showAlternatives?: boolean;
  /**
   * Blocks this tile's connect action while another integration holds the
   * attempt. There is one sign-in machine per assistant, so a second click
   * elsewhere would be swallowed rather than served.
   */
  disabled?: boolean;
  /** The plan's primary method, or an alternative picked from the menu. */
  onConnect: (method: ConnectMethod) => void;
  onLogin: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onOpenSetupGuide: (url: string) => void;
}

/**
 * One integration, connectable where it sits.
 *
 * The whole happy path is a single `+`: the waiting and the failing both land
 * in the tile rather than in a dialog the user has to keep open to watch. A
 * modal is for the two jobs that need a page of their own, the manual
 * allowlisting steps and the bring-your-own OAuth form.
 *
 * On a platform-hosted assistant the other ways to connect stay out of sight
 * until the recommended one fails: offering the choice up front asks every
 * user to understand our plumbing to answer a question that answers itself
 * nearly every time. A self-hosted assistant sets `showAlternatives`, and the
 * connect action grows a chevron for them.
 *
 * Purely presentational. Every side effect is a prop.
 */
export function IntegrationTile({
  plan,
  state,
  layout = "tile",
  showAlternatives = false,
  disabled = false,
  onConnect,
  onLogin,
  onCancel,
  onRetry,
  onOpenSetupGuide,
}: IntegrationTileProps) {
  const { t } = useTranslation("settings");
  const methodLabel = useConnectMethodLabel(plan.name);
  const inFlight = state.phase === "waiting" || state.phase === "connecting";

  function startMethod(method: ConnectMethod) {
    if (method.availability === "login-required") {
      onLogin();
      return;
    }
    onConnect(method);
  }

  function methodItems(methods: ConnectMethod[]): ReactNode[] {
    return connectMethodMenuItems(methods, methodLabel, startMethod);
  }

  // One button, whatever the assistant is signed in to. Without a platform
  // session the click goes to the login flow instead of to the provider,
  // rather than the tile spending a line of its own explaining that.
  const connectButton =
    showAlternatives && plan.alternatives.length > 0 ? (
      <SplitButton
        variant="outlined"
        className={INTEGRATION_ACTION_SIZING}
        iconOnly={<Plus />}
        aria-label={t("integrationTile.connect", { name: plan.name })}
        menuTitle={t("integrationTile.connect", { name: plan.name })}
        menuTriggerLabel={t("connectMethod.otherWaysLabel", {
          name: plan.name,
        })}
        // Every way in, the recommended one first: the chevron is the whole
        // list, so a user who opens it does not have to work out which path
        // the plus would have taken.
        menuItems={methodItems(planMethods(plan))}
        disabled={disabled}
        onClick={() => startMethod(plan.primary)}
      />
    ) : (
      <Button
        variant="outlined"
        className={INTEGRATION_ACTION_SIZING}
        iconOnly={<Plus />}
        aria-label={t("integrationTile.connect", { name: plan.name })}
        disabled={disabled}
        onClick={() => startMethod(plan.primary)}
      />
    );

  const action = inFlight ? (
    // The spinner keeps the action's footprint so the tile does not resize
    // under the pointer that just clicked it.
    <span className="flex size-8 items-center justify-center">
      <Loader2
        aria-hidden="true"
        className="size-4 animate-spin text-[var(--content-tertiary)]"
      />
    </span>
  ) : state.phase === "failed" ? (
    <Button
      variant="dangerOutline"
      className={INTEGRATION_ACTION_SIZING}
      iconOnly={<RefreshCw />}
      aria-label={t("integrationTile.retryLabel", { name: plan.name })}
      disabled={disabled}
      onClick={onRetry}
    />
  ) : (
    connectButton
  );

  let footer: ReactNode = null;
  if (state.phase === "failed") {
    // Every way in that is still open but the one that just failed. The method
    // that failed can be an alternative the user picked, so the menu has to be
    // able to offer the recommended path they skipped to get here, which
    // `plan.alternatives` by itself never contains.
    const otherMethods = connectableMethods(plan).filter(
      (method) => method.id !== state.methodId,
    );
    footer = (
      <FailureLine
        name={plan.name}
        state={state}
        menu={
          otherMethods.length > 0 ? (
            <ActionMenu.Root>
              <ActionMenu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="compact"
                  rightIcon={<ChevronDown />}
                >
                  {t("integrationTile.tryAnother")}
                </Button>
              </ActionMenu.Trigger>
              <ActionMenu.Content
                title={t("integrationTile.tryAnotherLabel", {
                  name: plan.name,
                })}
              >
                {methodItems(otherMethods)}
              </ActionMenu.Content>
            </ActionMenu.Root>
          ) : null
        }
        onOpenSetupGuide={onOpenSetupGuide}
      />
    );
  } else if (inFlight) {
    footer = (
      <ProgressLine name={plan.name} state={state} onCancel={onCancel} />
    );
  }

  return (
    <IntegrationListRow
      layout={layout}
      icon={
        <IntegrationIcon
          providerKey={plan.iconKey}
          displayName={plan.name}
          logoUrl={plan.logoUrl}
          size={32}
        />
      }
      title={plan.name}
      subtitle={plan.description ?? undefined}
      primaryAction={action}
      footer={footer}
    />
  );
}

function ProgressLine({
  name,
  state,
  onCancel,
}: {
  name: string;
  state: Extract<TileConnectState, { phase: "waiting" | "connecting" }>;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
      <p
        role="status"
        className="min-w-0 text-body-small-lighter text-[var(--content-secondary)]"
      >
        {state.phase === "waiting"
          ? t("integrationTile.waiting", { name })
          : t("integrationTile.connecting", { name })}
      </p>
      {state.phase === "waiting" && state.canCancel ? (
        <Button variant="ghost" size="compact" onClick={onCancel}>
          {t("integrationTile.cancel")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A failure costs the tile a few lines, not a dialog.
 *
 * A boxed notice inside a 15rem tile is most of the tile, and six of them on
 * one page is a wall. The state is carried by the colour of the text and by
 * the retry sitting where the connect action was, so the room that buys goes
 * to the message itself: three lines of it, the rest on the title attribute,
 * and the provider's own setup guide beside it.
 */
function FailureLine({
  name,
  state,
  menu,
  onOpenSetupGuide,
}: {
  name: string;
  state: Extract<TileConnectState, { phase: "failed" }>;
  menu: ReactNode;
  onOpenSetupGuide: (url: string) => void;
}) {
  const { t } = useTranslation("settings");
  const setupGuideUrl = isMcpMethodKind(state.methodKind)
    ? state.setupGuideUrl
    : undefined;
  // Whatever the provider said, in its own words. It is the only thing on
  // screen that can tell the user why, and often the only thing that tells
  // them what to do instead, so the tile gives it the height it needs and
  // clamps what is left over rather than trading it for a line that says
  // nothing. The generic sentence is for a failure that arrived with no
  // message at all.
  const message = state.error || t("integrationTile.failedGeneric", { name });

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1">
      <p
        role="alert"
        className="flex min-w-0 items-start gap-1.5 text-body-small-default text-[var(--system-negative-strong)]"
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span
          title={state.error || undefined}
          className="line-clamp-3 min-w-0 [overflow-wrap:anywhere]"
        >
          {message}
        </span>
      </p>
      {setupGuideUrl ? (
        <Button
          variant="ghost"
          size="compact"
          leftIcon={<ExternalLink />}
          onClick={() => onOpenSetupGuide(setupGuideUrl)}
        >
          {t("integrationTile.setupGuide")}
        </Button>
      ) : null}
      {menu}
    </div>
  );
}
