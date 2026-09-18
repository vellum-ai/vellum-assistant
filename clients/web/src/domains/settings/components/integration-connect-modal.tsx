import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";
import { Button } from "@vellumai/design-library/components/button";
import { Checkbox } from "@vellumai/design-library/components/checkbox";
import { Collapsible } from "@vellumai/design-library/components/collapsible";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Input } from "@vellumai/design-library/components/input";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { SplitButton } from "@vellumai/design-library/components/split-button";
import { Tag } from "@vellumai/design-library/components/tag";

import { IntegrationIcon } from "@/components/integrations/integration-icon";
import {
  useTenantHostInput,
  type TenantHostRequirement,
} from "@/hooks/use-tenant-host-input";
import { useTranslation } from "@/i18n";

import {
  connectMethodMenuItems,
  useConnectMethodLabel,
} from "../connect-method-display";
import {
  connectableMethods,
  isMcpMethodKind,
  planConnections,
  planMethods,
  type ConnectMethod,
  type ConnectPlan,
  type ConnectionSummary,
} from "../connect-plan";
import type { McpToolsSummaryServer } from "../mcp/mcp-api";

import { INTEGRATION_ACTION_SIZING } from "./integration-list-row";

/** A connect attempt the caller has in flight, or the failure it ended in. */
export interface ConnectAttempt {
  methodId: string;
  phase: "starting" | "authorizing" | "waiting" | "connecting" | "error";
  error?: string;
  canCancel: boolean;
}

/**
 * The callback URL a manual MCP setup asks an admin to allowlist. `ready`
 * carries the URL, so nothing downstream has to ask whether a ready state
 * actually has one to show or to gate Connect on.
 */
export type CallbackUrlState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; url: string };

export interface IntegrationConnectModalProps {
  plan: ConnectPlan;
  attempt?: ConnectAttempt | null;
  /**
   * The method to open on, for a caller that already knows which path the
   * user picked. Without it the dialog opens on what is connected, or on the
   * path that leads when nothing is.
   */
  focusMethodId?: string;
  /**
   * Manual MCP setup only, and only where the callback URL is known. Omitted,
   * the checklist is the provider's own instructions and Connect is not
   * gated on a URL nobody can show.
   */
  callbackUrl?: CallbackUrlState;
  callbackCopied?: boolean;
  /** Tools summary per MCP connection id, for the "Tools and details" view. */
  toolsByConnectionId?: Record<
    string,
    {
      loading?: boolean;
      error?: boolean;
      summary?: McpToolsSummaryServer;
      endpointUrl?: string;
    }
  >;
  /** The bring-your-own OAuth form, rendered when that path is picked. */
  ownOAuthContent?: ReactNode;
  /**
   * Per-tenant providers (Shopify): the host the managed sign-in has to be
   * pointed at, because the provider's OAuth endpoints live on the customer's
   * own domain. Absent for providers with one global host.
   */
  tenantHost?: TenantHostRequirement | null;
  onConnect: (
    method: ConnectMethod,
    options?: { acknowledged?: boolean; tenantHost?: string },
  ) => void;
  onLogin: () => void;
  onCancelAttempt: () => void;
  onRetryAttempt: () => void;
  onReconnect: (connection: ConnectionSummary) => void;
  onDisconnect: (connection: ConnectionSummary) => void;
  /**
   * The tools view has been opened on this connection. The summary itself
   * arrives back through `toolsByConnectionId`, so the caller can fetch it
   * only once a user asks for it.
   */
  onOpenTools?: (connection: ConnectionSummary) => void;
  /** Required by, and only by, a caller that supplies `callbackUrl`. */
  onCopyCallbackUrl?: (url: string) => void;
  onOpenSetupGuide: (url: string) => void;
  onClose: () => void;
}

type View =
  | { kind: "connect"; methodId: string }
  | { kind: "connections" }
  | { kind: "tools"; connectionId: string };

/**
 * Whose integration this is, on every view. The icon and the name are what
 * tells the user the back button moved them inside one integration rather
 * than out of it.
 */
function ConnectModalHeader({
  plan,
  title,
  description,
}: {
  plan: ConnectPlan;
  title: string;
  description: string;
}) {
  return (
    <Modal.Header>
      <div className="flex items-center gap-3">
        <IntegrationIcon
          providerKey={plan.iconKey}
          displayName={plan.name}
          logoUrl={plan.logoUrl}
          size={40}
        />
        <div className="flex min-w-0 flex-col">
          <Modal.Title className="[&>span]:whitespace-normal">
            {title}
          </Modal.Title>
          <Modal.Description>{description}</Modal.Description>
        </div>
      </div>
    </Modal.Header>
  );
}

/**
 * One modal for every way an integration connects.
 *
 * One decision, on one surface: the recommended path sits under a single
 * Connect button, the alternatives wait behind its chevron, and what a
 * connection *is* (its endpoint, its tools, its token cost) lives behind the
 * row it belongs to. A user should not have to understand our plumbing to
 * sign in to their own account.
 *
 * Three views, one dialog. It opens on the connections when there are any and
 * on the connect view when there are none, because the first question differs:
 * "what is already connected" against "how do I connect".
 *
 * Purely presentational: every side effect is a prop, so the surface can be
 * reviewed in Storybook against the plan {@link buildConnectPlan} derives from
 * the real catalog.
 */
export function IntegrationConnectModal({
  plan,
  attempt,
  focusMethodId,
  callbackUrl,
  callbackCopied = false,
  toolsByConnectionId,
  ownOAuthContent,
  tenantHost,
  onConnect,
  onLogin,
  onCancelAttempt,
  onRetryAttempt,
  onReconnect,
  onDisconnect,
  onOpenTools,
  onCopyCallbackUrl,
  onOpenSetupGuide,
  onClose,
}: IntegrationConnectModalProps) {
  const { t } = useTranslation("settings");
  const methodLabel = useConnectMethodLabel(plan.name);
  const methods = planMethods(plan);
  const connections = planConnections(plan);
  const [requestedView, setView] = useState<View>(() => {
    if (focusMethodId) {
      return { kind: "connect", methodId: focusMethodId };
    }
    return connections.length > 0
      ? { kind: "connections" }
      : { kind: "connect", methodId: plan.primary.id };
  });
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirming, setConfirming] = useState<ConnectionSummary | null>(null);

  /**
   * A disconnect can empty the list under an open dialog, and can take the row
   * a tools view is reading with it. The view follows the plan rather than the
   * click that opened it, because the question has changed: not "what is
   * connected" any more, but "how do I connect".
   */
  function resolveView(requested: View): View {
    if (requested.kind === "connect") {
      return requested;
    }
    if (connections.length === 0) {
      return { kind: "connect", methodId: plan.primary.id };
    }
    const gone =
      requested.kind === "tools" &&
      !connections.some(
        (candidate) => candidate.id === requested.connectionId,
      );
    return gone ? { kind: "connections" } : requested;
  }
  const view = resolveView(requestedView);

  function methodTag(method: ConnectMethod): string {
    switch (method.kind) {
      case "mcp-oauth":
      case "mcp-manual":
        return t("integrationConnect.tagMcp");
      case "managed-oauth":
        return t("integrationConnect.tagVellum");
      case "own-oauth":
        return t("integrationConnect.tagOwnApp");
    }
  }

  function connectionTitle(connection: ConnectionSummary): string {
    if (connection.label) {
      return connection.label;
    }
    return isMcpMethodKind(connection.methodKind)
      ? t("integrationConnect.connectionMcpLabel", { name: plan.name })
      : t("integrationConnect.connectionAccountLabel", { name: plan.name });
  }

  function methodItems(
    visible: ConnectMethod[],
    onPick: (method: ConnectMethod) => void,
  ): ReactNode[] {
    return connectMethodMenuItems(visible, methodLabel, onPick);
  }

  function openConnect(method: ConnectMethod) {
    setAcknowledged(false);
    setView({ kind: "connect", methodId: method.id });
  }

  function leaveConnect() {
    if (connections.length > 0) {
      setView({ kind: "connections" });
      return;
    }
    setView({ kind: "connect", methodId: plan.primary.id });
  }

  const toolsConnection =
    view.kind === "tools"
      ? connections.find((candidate) => candidate.id === view.connectionId)
      : undefined;

  // A method the plan no longer offers (the catalog changed under an open
  // modal) falls back to the one that leads, rather than emptying the view.
  const connectMethod =
    view.kind === "connect"
      ? (methods.find((candidate) => candidate.id === view.methodId) ??
        plan.primary)
      : plan.primary;

  // The guide belongs to the method it documents. A plan can carry several,
  // and the provider's MCP docs are no help to someone registering their own
  // OAuth app, so only the method on screen offers one.
  function setupGuideFor(method: ConnectMethod) {
    const url = method.setupGuideUrl;
    if (!url) {
      return null;
    }
    return (
      <Button
        variant="ghost"
        className="mr-auto min-h-11"
        leftIcon={<ExternalLink />}
        onClick={() => onOpenSetupGuide(url)}
      >
        {t("integrationConnect.setupGuide")}
      </Button>
    );
  }

  return (
    <Modal.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <Modal.Content size="md">
        {view.kind === "connect" ? (
          <ConnectView
            plan={plan}
            method={connectMethod}
            setupGuide={setupGuideFor(connectMethod)}
            methods={methods}
            attempt={attempt}
            callbackUrl={callbackUrl}
            callbackCopied={callbackCopied}
            ownOAuthContent={ownOAuthContent}
            tenantHost={tenantHost}
            acknowledged={acknowledged}
            hasConnections={connections.length > 0}
            methodItems={methodItems}
            onAcknowledge={setAcknowledged}
            onPickMethod={openConnect}
            onBack={leaveConnect}
            onConnect={onConnect}
            onLogin={onLogin}
            onCancelAttempt={onCancelAttempt}
            onRetryAttempt={onRetryAttempt}
            onCopyCallbackUrl={onCopyCallbackUrl}
            onClose={onClose}
          />
        ) : view.kind === "tools" ? (
          <ToolsView
            plan={plan}
            connection={toolsConnection}
            title={
              toolsConnection ? connectionTitle(toolsConnection) : plan.name
            }
            tools={toolsByConnectionId?.[view.connectionId]}
            onBack={() => setView({ kind: "connections" })}
            onClose={onClose}
          />
        ) : (
          <ConnectionsView
            plan={plan}
            methods={methods}
            connections={connections}
            connectionTitle={connectionTitle}
            methodTag={methodTag}
            methodItems={methodItems}
            onPickMethod={openConnect}
            onOpenTools={(connection) => {
              onOpenTools?.(connection);
              setView({ kind: "tools", connectionId: connection.id });
            }}
            onReconnect={(connection) => {
              onReconnect(connection);
              // The sign-in it starts is drawn on the method's own page, the
              // one surface in here with a progress line and a way out of it.
              setView({ kind: "connect", methodId: connection.methodId });
            }}
            onRequestDisconnect={setConfirming}
            onClose={onClose}
          />
        )}
      </Modal.Content>

      <ConfirmDialog
        open={confirming !== null}
        destructive
        title={t("integrationConnect.removeTitle", {
          label: confirming ? connectionTitle(confirming) : "",
        })}
        message={t("integrationConnect.removeMessage")}
        confirmLabel={t("integrationConnect.remove")}
        cancelLabel={t("integrationConnect.cancel")}
        onConfirm={() => {
          if (confirming) {
            onDisconnect(confirming);
          }
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </Modal.Root>
  );
}

// ---------------------------------------------------------------------------
// Connect view
// ---------------------------------------------------------------------------

function ConnectView({
  plan,
  method,
  methods,
  attempt,
  callbackUrl,
  callbackCopied,
  ownOAuthContent,
  tenantHost,
  acknowledged,
  hasConnections,
  setupGuide,
  methodItems,
  onAcknowledge,
  onPickMethod,
  onBack,
  onConnect,
  onLogin,
  onCancelAttempt,
  onRetryAttempt,
  onCopyCallbackUrl,
  onClose,
}: {
  plan: ConnectPlan;
  method: ConnectMethod;
  methods: ConnectMethod[];
  attempt?: ConnectAttempt | null;
  callbackUrl?: CallbackUrlState;
  callbackCopied: boolean;
  ownOAuthContent?: ReactNode;
  tenantHost?: TenantHostRequirement | null;
  acknowledged: boolean;
  hasConnections: boolean;
  setupGuide: ReactNode;
  methodItems: (
    visible: ConnectMethod[],
    onPick: (method: ConnectMethod) => void,
  ) => ReactNode[];
  onAcknowledge: (next: boolean) => void;
  onPickMethod: (method: ConnectMethod) => void;
  onBack: () => void;
  onConnect: (
    method: ConnectMethod,
    options?: { acknowledged?: boolean; tenantHost?: string },
  ) => void;
  onLogin: () => void;
  onCancelAttempt: () => void;
  onRetryAttempt: () => void;
  onCopyCallbackUrl?: (url: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  // Only the managed path opens an authorization on the provider's own
  // domain, so only it has to ask which one. The hook is inert without a
  // requirement, so every other method passes its result straight through.
  const hostNeeded = method.kind === "managed-oauth" ? tenantHost : null;
  const hostInput = useTenantHostInput(hostNeeded);
  const methodAttempt = attempt?.methodId === method.id ? attempt : null;
  const inFlight = methodAttempt !== null && methodAttempt.phase !== "error";
  const loginRequired = method.availability === "login-required";
  // A checklist only blocks Connect where there is a checklist: without a
  // callback URL to hand over, the manual path is the provider's own
  // instructions and the same sign-in every other method runs.
  const manualIncomplete =
    method.kind === "mcp-manual" &&
    callbackUrl !== undefined &&
    (!acknowledged || callbackUrl.status !== "ready");
  const showBack = method.id !== plan.primary.id || hasConnections;
  const others = methods.filter((candidate) => candidate.id !== method.id);

  return (
    <>
      <ConnectModalHeader
        plan={plan}
        title={t("integrationConnect.connectTitle", { name: plan.name })}
        description={
          plan.description ??
          t("integrationConnect.connectDescription", { name: plan.name })
        }
      />

      <Modal.Body className="space-y-4">
        {showBack ? (
          <Button variant="ghost" leftIcon={<ArrowLeft />} onClick={onBack}>
            {t("integrationConnect.back")}
          </Button>
        ) : null}

        {loginRequired ? (
          <Notice tone="info">
            {t("integrationConnect.loginRequired", { name: plan.name })}
          </Notice>
        ) : null}

        {methodAttempt ? (
          <AttemptNotice
            name={plan.name}
            attempt={methodAttempt}
            onCancel={onCancelAttempt}
            onRetry={onRetryAttempt}
          />
        ) : null}

        {hostNeeded ? (
          <Input
            label={hostNeeded.label}
            type="text"
            value={hostInput.value}
            onChange={(event) => hostInput.setValue(event.target.value)}
            placeholder={hostNeeded.placeholder}
            aria-invalid={hostInput.showsInvalid || undefined}
            helperText={
              hostInput.showsInvalid
                ? t("integrationConnect.tenantHostInvalid", {
                    label: hostNeeded.label,
                    placeholder: hostNeeded.placeholder,
                  })
                : undefined
            }
            disabled={inFlight}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            fullWidth
          />
        ) : null}

        {method.kind === "mcp-manual" ? (
          <ManualSteps
            instructions={method.instructions}
            name={plan.name}
            callbackUrl={callbackUrl}
            callbackCopied={callbackCopied}
            acknowledged={acknowledged}
            onAcknowledge={onAcknowledge}
            onCopyCallbackUrl={onCopyCallbackUrl}
          />
        ) : method.kind === "own-oauth" ? (
          ownOAuthContent
        ) : (
          <p className="text-body-medium-default text-[var(--content-secondary)]">
            {method.instructions ??
              t("integrationConnect.browserHint", { name: plan.name })}
          </p>
        )}
      </Modal.Body>

      <Modal.Footer>
        {setupGuide}
        <Button variant="ghost" className="min-h-11" onClick={onClose}>
          {t("integrationConnect.cancel")}
        </Button>
        {method.kind === "own-oauth" ? null : (
          <SplitButton
            className="min-h-11"
            disabled={inFlight || manualIncomplete || !hostInput.valid}
            // The steps above are what blocks Connect, and picking another way
            // in is one of the ways out of them, so the chevron stays live
            // while the main half waits.
            menuDisabled={inFlight}
            leftIcon={inFlight ? <Loader2 className="animate-spin" /> : null}
            menuTitle={t("integrationConnect.otherWays")}
            menuTriggerLabel={t("connectMethod.otherWaysLabel", {
              name: plan.name,
            })}
            menuItems={methodItems(others, onPickMethod)}
            onClick={() =>
              loginRequired
                ? onLogin()
                : onConnect(method, {
                    acknowledged,
                    tenantHost: hostInput.normalized,
                  })
            }
          >
            {loginRequired
              ? t("integrationConnect.loginToConnect")
              : t("integrationConnect.connect")}
          </SplitButton>
        )}
      </Modal.Footer>
    </>
  );
}

function AttemptNotice({
  name,
  attempt,
  onCancel,
  onRetry,
}: {
  name: string;
  attempt: ConnectAttempt;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation("settings");

  if (attempt.phase === "error") {
    return (
      <Notice
        tone="error"
        actions={
          <div className="flex gap-2">
            <Button variant="outlined" onClick={onRetry}>
              {t("integrationConnect.retry")}
            </Button>
            <Button variant="ghost" onClick={onCancel}>
              {attempt.canCancel
                ? t("integrationConnect.stopWaiting")
                : t("integrationConnect.cancel")}
            </Button>
          </div>
        }
      >
        <p>{attempt.error ?? t("integrationConnect.attemptFailed", { name })}</p>
      </Notice>
    );
  }

  const message =
    attempt.phase === "starting"
      ? t("integrationConnect.attemptStarting", { name })
      : attempt.phase === "connecting"
        ? t("integrationConnect.attemptConnecting", { name })
        : t("integrationConnect.attemptWaiting", { name });

  return (
    <Notice
      tone="info"
      icon={<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      actions={
        attempt.canCancel ? (
          <Button variant="ghost" onClick={onCancel}>
            {t("integrationConnect.stopWaiting")}
          </Button>
        ) : undefined
      }
    >
      {message}
    </Notice>
  );
}

function ManualSteps({
  instructions,
  name,
  callbackUrl,
  callbackCopied,
  acknowledged,
  onAcknowledge,
  onCopyCallbackUrl,
}: {
  instructions?: string;
  name: string;
  callbackUrl?: CallbackUrlState;
  callbackCopied: boolean;
  acknowledged: boolean;
  onAcknowledge: (next: boolean) => void;
  onCopyCallbackUrl?: (url: string) => void;
}) {
  const { t } = useTranslation("settings");
  const url = callbackUrl?.status === "ready" ? callbackUrl.url : undefined;

  const intro = instructions ? (
    <p className="text-body-medium-default text-[var(--content-secondary)]">
      {instructions}
    </p>
  ) : null;

  // Nothing to allowlist means nothing to walk through: the provider's own
  // words, and the same Connect the other methods offer.
  if (!callbackUrl) {
    return intro;
  }

  return (
    <>
      {intro}
      <ol className="space-y-4">
        <ManualStep index={1}>
          <p className="text-body-medium-default">
            {t("integrationConnect.manualStep1")}
          </p>
          {url ? (
            <div className="flex items-center gap-2 rounded-md border border-[var(--border-base)] bg-[var(--surface-base)] px-3 py-2">
              <code className="min-w-0 flex-1 font-mono text-body-small-default [overflow-wrap:anywhere]">
                {url}
              </code>
              {onCopyCallbackUrl ? (
                <Button
                  variant="outlined"
                  size="compact"
                  leftIcon={callbackCopied ? <Check /> : <Copy />}
                  onClick={() => onCopyCallbackUrl(url)}
                >
                  {callbackCopied
                    ? t("integrationConnect.copied")
                    : t("integrationConnect.copy")}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {callbackUrl?.status === "error"
                ? t("integrationConnect.callbackError")
                : t("integrationConnect.callbackLoading")}
            </p>
          )}
        </ManualStep>
        <ManualStep index={2}>
          <p className="text-body-medium-default">
            {t("integrationConnect.manualStep2", { name })}
          </p>
        </ManualStep>
        <ManualStep index={3}>
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(next) => onAcknowledge(next === true)}
            label={t("integrationConnect.manualStep3")}
          />
        </ManualStep>
      </ol>
    </>
  );
}

/** One numbered step, with the number in a column of its own so the step
 * bodies line up however tall each one grows. */
function ManualStep({
  index,
  children,
}: {
  index: number;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="w-3 shrink-0 text-body-medium-default text-[var(--content-tertiary)]">
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Connections view
// ---------------------------------------------------------------------------

function ConnectionsView({
  plan,
  methods,
  connections,
  connectionTitle,
  methodTag,
  methodItems,
  onPickMethod,
  onOpenTools,
  onReconnect,
  onRequestDisconnect,
  onClose,
}: {
  plan: ConnectPlan;
  methods: ConnectMethod[];
  connections: ConnectionSummary[];
  connectionTitle: (connection: ConnectionSummary) => string;
  methodTag: (method: ConnectMethod) => string;
  methodItems: (
    visible: ConnectMethod[],
    onPick: (method: ConnectMethod) => void,
  ) => ReactNode[];
  onPickMethod: (method: ConnectMethod) => void;
  onOpenTools: (connection: ConnectionSummary) => void;
  onReconnect: (connection: ConnectionSummary) => void;
  onRequestDisconnect: (connection: ConnectionSummary) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  // Only the paths that have another connection left in them. With none, the
  // list on screen is already everything this integration can be, so the
  // footer drops the control rather than opening an empty menu.
  const another = connectableMethods(plan);

  function subtitle(connection: ConnectionSummary): string | undefined {
    const method = methods.find(
      (candidate) => candidate.id === connection.methodId,
    );
    if (methods.length < 2 || !method) {
      return connection.detail;
    }
    const tag = methodTag(method);
    return connection.detail
      ? t("integrationConnect.connectionSubtitle", {
          method: tag,
          detail: connection.detail,
        })
      : tag;
  }

  return (
    <>
      <ConnectModalHeader
        plan={plan}
        title={plan.name}
        description={t("integrationConnect.connectionsDescription", {
          name: plan.name,
        })}
      />

      <Modal.Body>
        <div className="rounded-lg border border-[var(--border-base)]">
          {connections.map((connection) => (
            <ListRow
              key={connection.id}
              title={connectionTitle(connection)}
              subtitle={subtitle(connection)}
              trailingInteractive
              trailing={
                // A thumb grows every control to 44px, which is more than a
                // phone-width row can line up beside a title. Capped to the
                // width of the two icon buttons there, the status and the
                // reconnect wrap above them instead of pushing the title out.
                <div className="flex flex-wrap items-center justify-end gap-2 touch-mobile:max-w-24">
                  <ConnectionStatusTag status={connection.status} />
                  {connection.canReconnect ? (
                    <Button
                      variant="outlined"
                      size="compact"
                      leftIcon={<RefreshCw />}
                      onClick={() => onReconnect(connection)}
                    >
                      {connection.status === "pending"
                        ? t("integrationConnect.finishConnecting")
                        : t("integrationConnect.reconnect")}
                    </Button>
                  ) : null}
                  {isMcpMethodKind(connection.methodKind) ? (
                    <Button
                      variant="outlined"
                      className={INTEGRATION_ACTION_SIZING}
                      iconOnly={<Wrench />}
                      aria-label={t("integrationConnect.toolsAndDetailsLabel", {
                        label: connectionTitle(connection),
                      })}
                      onClick={() => onOpenTools(connection)}
                    />
                  ) : null}
                  <Button
                    variant="dangerOutline"
                    className={INTEGRATION_ACTION_SIZING}
                    iconOnly={<Trash2 />}
                    aria-label={t("integrationConnect.removeLabel", {
                      label: connectionTitle(connection),
                    })}
                    onClick={() => onRequestDisconnect(connection)}
                  />
                </div>
              }
            />
          ))}
        </div>
      </Modal.Body>

      <Modal.Footer>
        {another.length > 0 ? (
          <ActionMenu.Root>
            <ActionMenu.Trigger asChild>
              <Button
                variant="outlined"
                className="min-h-11"
                rightIcon={<ChevronDown />}
              >
                {t("integrationConnect.connectAnother")}
              </Button>
            </ActionMenu.Trigger>
            <ActionMenu.Content title={t("integrationConnect.connectAnother")}>
              {methodItems(another, onPickMethod)}
            </ActionMenu.Content>
          </ActionMenu.Root>
        ) : null}
        <Button className="min-h-11" onClick={onClose}>
          {t("integrationConnect.done")}
        </Button>
      </Modal.Footer>
    </>
  );
}

/**
 * Connected is the default and gets no chip: a row that says "Connected" on
 * every healthy connection trains the eye to skip the one that does not.
 */
function ConnectionStatusTag({
  status,
}: {
  status: ConnectionSummary["status"];
}) {
  const { t } = useTranslation("settings");
  switch (status) {
    case "needs-attention":
      return (
        <Tag tone="negative">
          {t("integrationConnect.statusNeedsAttention")}
        </Tag>
      );
    case "connecting":
      return <Tag>{t("integrationConnect.statusConnecting")}</Tag>;
    case "pending":
      return <Tag>{t("integrationConnect.statusPending")}</Tag>;
    case "connected":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Tools and details view
// ---------------------------------------------------------------------------

function ToolsView({
  plan,
  connection,
  title,
  tools,
  onBack,
  onClose,
}: {
  plan: ConnectPlan;
  connection?: ConnectionSummary;
  title: string;
  tools?: {
    loading?: boolean;
    error?: boolean;
    summary?: McpToolsSummaryServer;
    endpointUrl?: string;
  };
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const summary = tools?.summary;

  return (
    <>
      <ConnectModalHeader
        plan={plan}
        title={title}
        description={t("integrationConnect.toolsAndDetails")}
      />

      <Modal.Body className="space-y-4">
        <Button variant="ghost" leftIcon={<ArrowLeft />} onClick={onBack}>
          {t("integrationConnect.back")}
        </Button>

        <dl className="space-y-1">
          <dt className="text-body-small-default text-[var(--content-secondary)]">
            {t("integrationConnect.endpoint")}
          </dt>
          <dd className="font-mono text-body-small-default text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
            {tools?.endpointUrl ??
              connection?.detail ??
              t("integrationConnect.endpointUnknown")}
          </dd>
        </dl>

        {tools?.loading ? (
          <p
            role="status"
            className="text-body-small-default text-[var(--content-tertiary)]"
          >
            {t("integrationConnect.toolsLoading")}
          </p>
        ) : tools?.error ? (
          <p
            role="alert"
            className="text-body-small-default text-[var(--content-tertiary)]"
          >
            {t("integrationConnect.toolsError")}
          </p>
        ) : summary && summary.tools.length > 0 ? (
          <div className="space-y-2">
            <p className="text-body-small-default text-[var(--content-secondary)]">
              {t("integrationConnect.toolsSummary", {
                count: summary.toolCount,
                tokens: summary.estimatedTokens,
              })}
            </p>
            <Collapsible.Root
              type="multiple"
              className="rounded-lg border border-[var(--border-base)]"
            >
              {summary.tools.map((tool) => (
                <Collapsible.Item
                  key={tool.name}
                  value={tool.name}
                  className="border-b border-[var(--border-base)] last:border-b-0"
                >
                  <Collapsible.Trigger className="justify-between gap-2 px-3 py-2.5 text-left [&[data-state=open]>svg]:rotate-180">
                    <span className="min-w-0 flex-1 truncate font-mono text-body-small-default">
                      {tool.name}
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-[var(--content-tertiary)] transition-transform duration-150"
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div className="space-y-1 px-3 pb-3">
                      {tool.description ? (
                        <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-secondary)] [overflow-wrap:anywhere]">
                          {tool.description}
                        </p>
                      ) : null}
                      <p className="text-body-small-default text-[var(--content-tertiary)]">
                        {t("integrationConnect.toolTokens", {
                          tokens: tool.estimatedTokens,
                        })}
                      </p>
                    </div>
                  </Collapsible.Content>
                </Collapsible.Item>
              ))}
            </Collapsible.Root>
          </div>
        ) : (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {t("integrationConnect.toolsEmpty")}
          </p>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button className="min-h-11" onClick={onClose}>
          {t("integrationConnect.done")}
        </Button>
      </Modal.Footer>
    </>
  );
}
