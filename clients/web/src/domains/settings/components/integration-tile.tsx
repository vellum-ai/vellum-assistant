import {
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import {
  Button,
  buttonVariants,
} from "@vellumai/design-library/components/button";
import { SplitButton } from "@vellumai/design-library/components/split-button";
import { Tooltip } from "@vellumai/design-library/components/tooltip";
import { cn } from "@vellumai/design-library/utils/cn";
import { useHoverCapable } from "@vellumai/design-library/utils/hover-capability";

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
      /** The provider's own words. Shown in place of the description. */
      error: string;
      /**
       * The method that failed. The chevron on the retry offers every other
       * method still open to the plan, so the way out of a failed alternative
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
 * The tile is the same height in every one of those states, and that is the
 * point. These are grid cells, and a grid row stretches to its tallest cell,
 * so a line of status text on one tile puts empty space into every neighbour
 * beside it. Nothing a connect attempt has to say is allowed to add a line:
 * the progress and the way to call it off live in the action slot the connect
 * button already occupies, and a failure spends the description's two
 * reserved lines rather than asking for lines of its own.
 *
 * Where the device cannot hover there is no tooltip to carry the progress, so
 * the attempt spends those same two lines the way a failure does. The
 * description is what the user reads to decide whether to connect, and they
 * have decided; on a phone it is worth less than knowing there is a sign-in
 * waiting for them in another tab.
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
  const hoverCapable = useHoverCapable();
  const inFlight = state.phase === "waiting" || state.phase === "connecting";
  // Only one of the two says it, so neither is read out twice.
  const progressInBody = inFlight && !hoverCapable;

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

  let action: ReactNode = connectButton;
  if (inFlight) {
    action = (
      <ProgressAction
        name={plan.name}
        state={state}
        announce={!progressInBody}
        onCancel={onCancel}
      />
    );
  } else if (state.phase === "failed") {
    action = (
      <RetryAction
        plan={plan}
        state={state}
        disabled={disabled}
        methodItems={methodItems}
        onRetry={onRetry}
        onOpenSetupGuide={onOpenSetupGuide}
      />
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
      subtitle={
        state.phase === "failed" ? (
          <FailureText name={plan.name} state={state} />
        ) : progressInBody && inFlight ? (
          <span role="status">{progressMessage(t, plan.name, state)}</span>
        ) : (
          (plan.description ?? undefined)
        )
      }
      primaryAction={action}
    />
  );
}

/**
 * How long an X a finger revealed stays up before the spinner comes back.
 * Long enough to read the square and press it again, short enough that a tile
 * armed by a stray tap is not still armed when the user comes back to it.
 */
const TOUCH_ARMED_MS = 4000;

/** What an attempt in this phase has to say for itself. */
function progressMessage(
  t: ReturnType<typeof useTranslation<"settings">>["t"],
  name: string,
  state: Extract<TileConnectState, { phase: "waiting" | "connecting" }>,
): string {
  return state.phase === "waiting"
    ? t("integrationTile.waiting", { name })
    : t("integrationTile.connecting", { name });
}

/**
 * A failure in the space the description was using.
 *
 * The description is the one thing on the tile the user no longer needs: they
 * have already decided to connect this integration, and what they need now is
 * why it did not. Swapping one for the other buys the message two lines that
 * were reserved anyway, at no cost in height to the row of tiles beside it.
 * The rest of a long message is on the `title`, and the colour and the glyph
 * together say which kind of line this is, so the state does not rest on
 * colour alone.
 */
function FailureText({
  name,
  state,
}: {
  name: string;
  state: Extract<TileConnectState, { phase: "failed" }>;
}) {
  const { t } = useTranslation("settings");
  // Whatever the provider said, in its own words. It is the only thing on
  // screen that can tell the user why, and often the only thing that tells
  // them what to do instead. The generic sentence is for a failure that
  // arrived with no message at all.
  const message = state.error || t("integrationTile.failedGeneric", { name });

  return (
    <span
      role="alert"
      title={state.error || undefined}
      className="font-medium text-[var(--system-negative-strong)]"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mr-1 inline size-3.5 shrink-0 align-[-0.15em]"
      />
      {message}
    </span>
  );
}

/**
 * The retry, with every other way in a chevron away.
 *
 * The menu holds the provider's own setup guide, then the methods this plan
 * still has that are not the one that just failed. It is a menu rather than a
 * row of buttons because a row of buttons is two more lines, and two more
 * lines on one tile is empty space on every tile in the row. With nothing
 * behind it the chevron is not drawn, so a managed sign-in that has nowhere
 * else to go keeps a plain square retry.
 */
function RetryAction({
  plan,
  state,
  disabled,
  methodItems,
  onRetry,
  onOpenSetupGuide,
}: {
  plan: ConnectPlan;
  state: Extract<TileConnectState, { phase: "failed" }>;
  disabled: boolean;
  methodItems: (methods: ConnectMethod[]) => ReactNode[];
  onRetry: () => void;
  onOpenSetupGuide: (url: string) => void;
}) {
  const { t } = useTranslation("settings");
  const setupGuideUrl = isMcpMethodKind(state.methodKind)
    ? state.setupGuideUrl
    : undefined;
  // Every way in that is still open but the one that just failed. The method
  // that failed can be an alternative the user picked, so the menu has to be
  // able to offer the recommended path they skipped to get here, which
  // `plan.alternatives` by itself never contains.
  const otherMethods = connectableMethods(plan).filter(
    (method) => method.id !== state.methodId,
  );
  const menuItems: ReactNode[] = [
    ...(setupGuideUrl
      ? [
          <ActionMenu.Item
            key="setup-guide"
            icon={ExternalLink}
            label={t("integrationTile.setupGuide")}
            onSelect={() => onOpenSetupGuide(setupGuideUrl)}
          />,
        ]
      : []),
    ...methodItems(otherMethods),
  ];
  const label = t("integrationTile.retryLabel", { name: plan.name });

  if (menuItems.length === 0) {
    return (
      <Button
        variant="dangerOutline"
        className={INTEGRATION_ACTION_SIZING}
        iconOnly={<RefreshCw />}
        aria-label={label}
        disabled={disabled}
        onClick={onRetry}
      />
    );
  }

  return (
    <SplitButton
      variant="dangerOutline"
      className={INTEGRATION_ACTION_SIZING}
      iconOnly={<RefreshCw />}
      aria-label={label}
      menuTitle={t("connectMethod.otherWaysLabel", { name: plan.name })}
      menuTriggerLabel={t("connectMethod.otherWaysLabel", { name: plan.name })}
      menuItems={menuItems}
      disabled={disabled}
      onClick={onRetry}
    />
  );
}

/**
 * An attempt in flight, drawn entirely inside the action slot.
 *
 * The slot is the one place on a tile with room to spare, so the spinner goes
 * where the plus was and what the attempt has to say goes on its tooltip. A
 * wait that can be called off makes the spinner a button that turns into an
 * X; a wait that cannot is the same square with nothing to click, since a
 * control that looks live and does nothing is worse than no control.
 */
function ProgressAction({
  name,
  state,
  announce,
  onCancel,
}: {
  name: string;
  state: Extract<TileConnectState, { phase: "waiting" | "connecting" }>;
  /**
   * Put the message in a live region here. False where the tile body already
   * carries it visibly, so it is not announced twice.
   */
  announce: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation("settings");
  const hoverCapable = useHoverCapable();
  /**
   * Whether the slot is showing the X rather than the spinner.
   *
   * A pointer that hovers reveals it on arrival, and the tooltip comes up
   * with it, so the click that follows is aimed at a control that has already
   * said what it does. A pointer that does not gets no such warning, so its
   * first press only reveals and the second one cancels: a sign-in thrown
   * away by a mis-aimed thumb cannot be had back by pressing again.
   */
  const [revealed, setRevealed] = useState(false);
  /** Runs out an X a finger revealed. Never set for a pointer that hovers. */
  const disarm = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canCancel = state.phase === "waiting" && state.canCancel;
  const status = progressMessage(t, name, state);

  function clearDisarm() {
    if (disarm.current) {
      clearTimeout(disarm.current);
      disarm.current = null;
    }
  }

  function reveal(byTouch: boolean) {
    clearDisarm();
    setRevealed(true);
    // A hovering pointer takes the X back when it leaves. A finger has no
    // such moment, and a tile left armed turns the next curious tap into a
    // cancel, so the reveal runs out on its own instead.
    if (byTouch) {
      disarm.current = setTimeout(() => setRevealed(false), TOUCH_ARMED_MS);
    }
  }

  function conceal() {
    clearDisarm();
    setRevealed(false);
  }

  useEffect(() => clearDisarm, []);

  /**
   * Whether this pointer arriving is a warning the user has had.
   *
   * Both halves are needed. The device has to be able to hover at all, or the
   * tooltip was never mounted and there was nothing to read. And the pointer
   * that arrived has to be one that hovers rather than one that reports
   * itself on contact: a finger, or a stylus on a tablet that answers
   * `hover: none`, enters and clicks in the same touch.
   */
  function warned(pointerType: string) {
    return hoverCapable && pointerType !== "touch";
  }

  const announcement = announce ? (
    <span role="status" className="sr-only">
      {status}
    </span>
  ) : null;

  if (!canCancel) {
    return (
      <>
        <Tooltip content={status}>
          {/*
           * Styled as the button it is not, so the slot holds one square
           * through idle, waiting, connecting, and failed rather than
           * flickering a border on and off between them.
           */}
          <span
            className={cn(
              buttonVariants({ variant: "outlined", iconOnly: true }),
              INTEGRATION_ACTION_SIZING,
              // The square is borrowed, the button's behaviour is not: a
              // pointer over it must not light it up as though it did
              // something.
              "cursor-default hover:bg-transparent",
            )}
          >
            <Loader2
              aria-hidden="true"
              className="size-3.5 animate-spin text-[var(--content-tertiary)]"
            />
          </span>
        </Tooltip>
        {announcement}
      </>
    );
  }

  return (
    <>
      <Button
        variant="outlined"
        className={INTEGRATION_ACTION_SIZING}
        iconOnly={revealed ? <X /> : <Loader2 className="animate-spin" />}
        aria-label={t("integrationTile.cancelLabel", { name })}
        tooltip={t("integrationTile.waitingCancel", { name })}
        onPointerEnter={(event) => {
          if (warned(event.pointerType)) {
            reveal(false);
          }
        }}
        // A pointer that lands on contact sends its leave before its click,
        // so taking the X back here would take it back between the press that
        // revealed it and the press that meant it, and the sign-in could
        // never be called off at all. Only a pointer that was hovering has a
        // leave worth acting on.
        onPointerLeave={(event) => {
          if (warned(event.pointerType)) {
            conceal();
          }
        }}
        onBlur={conceal}
        onClick={(event) => {
          // A keyboard press and an assistive-technology activation carry no
          // pointer, so `detail` is 0. There is no mis-aimed thumb to guard
          // against and the control is already announced by what it does, so
          // the first activation is the one that means it.
          if (revealed || event.detail === 0) {
            conceal();
            onCancel();
            return;
          }
          reveal(true);
        }}
      />
      {announcement}
    </>
  );
}
