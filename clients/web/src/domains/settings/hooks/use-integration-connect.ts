import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@vellumai/design-library/components/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePluginsInstallPostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { requiresTenantHost } from "@/hooks/use-tenant-host-requirement";
import { useTranslation } from "@/i18n";
import { invalidatePluginQueries } from "@/lib/invalidate-plugin-queries";

import type { ManagedConnectReport } from "../components/managed-connect-controller";
import type { ConnectAttempt } from "../components/integration-connect-modal";
import type { TileConnectState } from "../components/integration-tile";
import {
  isMcpMethodKind,
  planMethods,
  type ConnectMethod,
  type ConnectMethodKind,
  type ConnectPlan,
  type ConnectableIntegrationItem,
  type ConnectionSummary,
} from "../connect-plan";
import { mcpServersForPlugin } from "../integration-items";
import {
  preparePluginMcpConnect,
  provisionalPluginServerId,
} from "../mcp/plugin-mcp-connect";
import type { useMcpConnections } from "../mcp/use-mcp-connections";

const IDLE: TileConnectState = { phase: "idle" };

/** The MCP sign-in a tile started, tracked by the operation it owns. */
interface McpAttemptRecord {
  itemId: string;
  methodId: string;
  methodKind: ConnectMethodKind;
  setupGuideUrl?: string;
  operationId: string;
}

/** The managed authorization a tile started. */
export interface ManagedAttemptRecord {
  itemId: string;
  methodId: string;
  providerKey: string;
  providerLabel: string;
  /** The host a per-tenant provider's authorization has to be opened on. */
  tenantHost?: string;
  /** Bumped by a retry, so the controller starts a fresh authorization. */
  restartToken: number;
}

/** The integration whose connect dialog is open. */
export interface ConnectModalTarget {
  itemId: string;
  /** The method to open on. Without one the dialog decides for itself. */
  methodId?: string;
}

export interface UseIntegrationConnectOptions {
  /** The assistant the MCP servers and plugins belong to. */
  assistantId: string;
  mcp: ReturnType<typeof useMcpConnections>;
}

/** What a surface with room to ask can supply along with the method. */
export interface ConnectRunOptions {
  /** The host a per-tenant provider's authorization has to be opened on. */
  tenantHost?: string;
}

export interface IntegrationConnect {
  /** A method picked on a tile. Routes it to whichever surface can run it. */
  start: (
    item: ConnectableIntegrationItem,
    plan: ConnectPlan,
    method: ConnectMethod,
  ) => void;
  /** A method picked on a surface that is already open. Runs it. */
  run: (
    item: ConnectableIntegrationItem,
    plan: ConnectPlan,
    method: ConnectMethod,
    options?: ConnectRunOptions,
  ) => void;
  /** Sign in again on a connection that already exists. */
  reconnect: (
    item: ConnectableIntegrationItem,
    plan: ConnectPlan,
    connection: ConnectionSummary,
  ) => void;
  cancel: () => void;
  retry: () => void;
  /** What the tile for this integration should be showing. */
  stateFor: (itemId: string, name: string) => TileConnectState;
  /** The same attempt, in the shape the connect modal reads. */
  attemptFor: (itemId: string) => ConnectAttempt | null;
  /** True while another integration is mid-attempt. */
  isBusyElsewhere: (itemId: string) => boolean;
  /** True while a tile is already reporting the MCP sign-in in flight. */
  ownsMcpAttempt: boolean;
  /**
   * The integration the live attempt belongs to. The page keeps it on the
   * available list until the attempt ends, so a card does not change section
   * under the pointer that is watching it.
   */
  attemptItemId: string | null;
  managed: ManagedAttemptRecord | null;
  onManagedReport: (report: ManagedConnectReport) => void;
  modal: ConnectModalTarget | null;
  /** Open the connect dialog for an integration, on a method or on its own. */
  openModal: (itemId: string, methodId?: string) => void;
  closeModal: () => void;
}

/**
 * One connect attempt at a time, for a whole page of integrations.
 *
 * The two machines that run an attempt are singletons by construction: the
 * daemon's MCP sign-in is one state machine per assistant, and a managed
 * authorization holds listeners a forty-row list must not hold forty of. So
 * the page owns the attempt and each tile only renders it. What a tile hands
 * over is a method; what it gets back is a phase.
 *
 * The MCP machine is shared with the custom-server cards, which start
 * attempts of their own. Ownership is decided by the operation id the machine
 * mints, claimed on the render after `connect` is called, so an attempt this
 * hook did not start is never drawn inside a tile.
 */
export function useIntegrationConnect({
  assistantId,
  mcp,
}: UseIntegrationConnectOptions): IntegrationConnect {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const { mutateAsync: installPluginAsync } = usePluginsInstallPostMutation();

  const [mcpAttempt, setMcpAttempt] = useState<McpAttemptRecord | null>(null);
  const [managed, setManaged] = useState<ManagedAttemptRecord | null>(null);
  const [managedReport, setManagedReport] =
    useState<ManagedConnectReport | null>(null);
  const [modal, setModal] = useState<ConnectModalTarget | null>(null);

  /** An MCP attempt asked for but not yet matched to an operation id. */
  const pendingMcp = useRef<
    | (Omit<McpAttemptRecord, "operationId"> & {
        priorOperationId: string | null;
      })
    | null
  >(null);

  const authAttempt = mcp.auth.attempt;
  const authConnect = mcp.auth.connect;
  const authRetry = mcp.auth.retry;
  const authStopWaiting = mcp.auth.stopWaiting;
  const authIsBusy = mcp.auth.isBusy;
  const refetchServers = mcp.list.refetch;

  // The machine mints an operation id synchronously inside `connect`, so the
  // very next render either carries the new attempt or says the machine
  // refused. Either way the request is answered here and not left pending for
  // some later attempt to adopt.
  useEffect(() => {
    const pending = pendingMcp.current;
    if (pending) {
      pendingMcp.current = null;
      if (authAttempt && authAttempt.operationId !== pending.priorOperationId) {
        setMcpAttempt({
          itemId: pending.itemId,
          methodId: pending.methodId,
          methodKind: pending.methodKind,
          setupGuideUrl: pending.setupGuideUrl,
          operationId: authAttempt.operationId,
        });
        return;
      }
    }
    // The attempt ended, or another surface replaced it with one of its own.
    if (mcpAttempt && authAttempt?.operationId !== mcpAttempt.operationId) {
      setMcpAttempt(null);
    }
  }, [authAttempt, mcpAttempt]);

  // The connection the platform reports moves the integration to the
  // connected list on its own; all that is left to say is that it landed.
  useEffect(() => {
    if (!managed || managedReport?.status !== "connected") {
      return;
    }
    toast.success(
      t("useOauthConnect.accountConnected", {
        name: managed.providerLabel,
        ns: "common",
      }),
    );
    setManaged(null);
    setManagedReport(null);
  }, [managed, managedReport, t]);

  const loadPluginServers = useCallback(
    async (pluginName: string) => {
      const result = await refetchServers();
      if (result.isError) {
        return [];
      }
      return mcpServersForPlugin(result.data?.servers ?? [], pluginName);
    },
    [refetchServers],
  );

  const installPlugin = useCallback(
    async (pluginName: string) => {
      await installPluginAsync({
        path: { assistant_id: assistantId },
        body: { name: pluginName },
      });
      invalidatePluginQueries(queryClient, assistantId, pluginName);
    },
    [assistantId, installPluginAsync, queryClient],
  );

  // Whatever was on screen for the last attempt, gone. A method picked from
  // "Try another way" is a replacement, and the failure it replaces must not
  // outlive it: `stateFor` reads one record per integration, so a stale one
  // would hide the attempt the user just started and come back afterwards.
  const cancel = useCallback(() => {
    if (mcpAttempt) {
      authStopWaiting();
    }
    setManaged(null);
    setManagedReport(null);
  }, [authStopWaiting, mcpAttempt]);

  /**
   * Hand an MCP sign-in to the machine and record that this hook asked for it,
   * so the attempt it mints on the next render is drawn where it was started.
   */
  const claimMcp = useCallback(
    (
      record: Omit<McpAttemptRecord, "operationId">,
      serverId: string,
      displayName: string,
      prepare?: () => Promise<string | null>,
    ) => {
      cancel();
      pendingMcp.current = {
        ...record,
        priorOperationId: authAttempt?.operationId ?? null,
      };
      authConnect(serverId, prepare, displayName);
    },
    [authAttempt, authConnect, cancel],
  );

  const startMcp = useCallback(
    (
      item: ConnectableIntegrationItem,
      plan: ConnectPlan,
      method: ConnectMethod,
    ) => {
      const definition = method.plugin;
      if (!definition || authIsBusy) {
        return;
      }
      // A plugin that is already installed must not be installed again: the
      // install refuses an existing copy rather than reusing it, and the
      // attempt would end on that refusal without reaching the provider. Its
      // servers are declared already, so the preparation is left with only
      // the job of naming the one to authorize.
      const installed = Boolean(definition.installed);
      claimMcp(
        {
          itemId: item.id,
          methodId: method.id,
          methodKind: method.kind,
          setupGuideUrl: method.setupGuideUrl,
        },
        provisionalPluginServerId(definition.pluginName),
        plan.name,
        preparePluginMcpConnect({
          install: installed
            ? () => Promise.resolve()
            : () => installPlugin(definition.pluginName),
          loadPluginServers: () => loadPluginServers(definition.pluginName),
        }),
      );
    },
    [authIsBusy, claimMcp, installPlugin, loadPluginServers],
  );

  const startManaged = useCallback(
    (
      item: ConnectableIntegrationItem,
      plan: ConnectPlan,
      method: ConnectMethod,
      options?: ConnectRunOptions,
    ) => {
      if (item.kind !== "oauth" || authIsBusy) {
        return;
      }
      const { provider } = item;
      // A tile has nowhere to ask for the customer's own domain, so a
      // per-tenant provider goes to the dialog that does rather than opening
      // an authorization that cannot succeed.
      if (
        !options?.tenantHost &&
        requiresTenantHost(provider.provider_key, provider.tenant_host)
      ) {
        setModal({ itemId: item.id, methodId: method.id });
        return;
      }
      cancel();
      setManaged({
        itemId: item.id,
        methodId: method.id,
        providerKey: provider.provider_key,
        providerLabel: plan.name,
        tenantHost: options?.tenantHost,
        restartToken: 0,
      });
    },
    [authIsBusy, cancel],
  );

  const run = useCallback(
    (
      item: ConnectableIntegrationItem,
      plan: ConnectPlan,
      method: ConnectMethod,
      options?: ConnectRunOptions,
    ) => {
      if (isMcpMethodKind(method.kind)) {
        startMcp(item, plan, method);
        return;
      }
      if (method.kind === "managed-oauth") {
        startManaged(item, plan, method, options);
      }
    },
    [startManaged, startMcp],
  );

  /**
   * A connection that exists already needs its own server signed in to, not a
   * fresh install: the plugin is there and only the grant has lapsed. The
   * attempt is claimed the same way, so the dialog that asked for it draws it.
   */
  const reconnect = useCallback(
    (
      item: ConnectableIntegrationItem,
      plan: ConnectPlan,
      connection: ConnectionSummary,
    ) => {
      const method = planMethods(plan).find(
        (candidate) => candidate.id === connection.methodId,
      );
      if (!isMcpMethodKind(connection.methodKind)) {
        if (method) {
          startManaged(item, plan, method);
        }
        return;
      }
      if (!connection.serverId || authIsBusy) {
        return;
      }
      claimMcp(
        {
          itemId: item.id,
          methodId: connection.methodId,
          methodKind: connection.methodKind,
          setupGuideUrl: method?.setupGuideUrl,
        },
        connection.serverId,
        plan.name,
      );
    },
    [authIsBusy, claimMcp, startManaged],
  );

  const start = useCallback(
    (
      item: ConnectableIntegrationItem,
      plan: ConnectPlan,
      method: ConnectMethod,
    ) => {
      // A manual allowlisting checklist and a bring-your-own OAuth form are
      // the two paths that need more room than a tile has. Everything else
      // runs where the user clicked.
      if (method.kind === "mcp-manual" || method.kind === "own-oauth") {
        setModal({ itemId: item.id, methodId: method.id });
        return;
      }
      run(item, plan, method);
    },
    [run],
  );

  const retry = useCallback(() => {
    if (mcpAttempt) {
      // The machine only starts a new operation from a failed one. Recording
      // a request it will refuse would leave it waiting to adopt whatever
      // attempt came next, including one from a custom server's card.
      if (authAttempt?.phase !== "error") {
        return;
      }
      pendingMcp.current = {
        itemId: mcpAttempt.itemId,
        methodId: mcpAttempt.methodId,
        methodKind: mcpAttempt.methodKind,
        setupGuideUrl: mcpAttempt.setupGuideUrl,
        priorOperationId: mcpAttempt.operationId,
      };
      authRetry();
      return;
    }
    setManagedReport(null);
    setManaged((current) =>
      current ? { ...current, restartToken: current.restartToken + 1 } : current,
    );
  }, [authAttempt, authRetry, mcpAttempt]);

  const stateFor = useCallback(
    (itemId: string, name: string): TileConnectState => {
      if (mcpAttempt?.itemId === itemId && authAttempt) {
        if (authAttempt.phase === "error") {
          return {
            phase: "failed",
            error:
              authAttempt.error ?? t("integrationTile.failedGeneric", { name }),
            methodId: mcpAttempt.methodId,
            methodKind: mcpAttempt.methodKind,
            setupGuideUrl: mcpAttempt.setupGuideUrl,
          };
        }
        return authAttempt.phase === "connecting"
          ? { phase: "connecting" }
          : { phase: "waiting", canCancel: true };
      }
      if (managed?.itemId === itemId) {
        if (managedReport?.errorMessage) {
          return {
            phase: "failed",
            error: managedReport.errorMessage,
            methodId: managed.methodId,
            methodKind: "managed-oauth",
          };
        }
        return { phase: "waiting", canCancel: true };
      }
      return IDLE;
    },
    [authAttempt, managed, managedReport, mcpAttempt, t],
  );

  const attemptFor = useCallback(
    (itemId: string): ConnectAttempt | null => {
      if (mcpAttempt?.itemId === itemId && authAttempt) {
        return {
          methodId: mcpAttempt.methodId,
          phase: authAttempt.phase,
          error: authAttempt.error,
          canCancel: true,
        };
      }
      if (managed?.itemId === itemId) {
        return {
          methodId: managed.methodId,
          phase: managedReport?.errorMessage ? "error" : "waiting",
          error: managedReport?.errorMessage ?? undefined,
          canCancel: true,
        };
      }
      return null;
    },
    [authAttempt, managed, managedReport, mcpAttempt],
  );

  const isBusyElsewhere = useCallback(
    (itemId: string) =>
      (authIsBusy && mcpAttempt?.itemId !== itemId) ||
      (managed !== null && managed.itemId !== itemId),
    [authIsBusy, managed, mcpAttempt],
  );

  const openModal = useCallback(
    (itemId: string, methodId?: string) => setModal({ itemId, methodId }),
    [],
  );
  const closeModal = useCallback(() => setModal(null), []);

  return {
    start,
    run,
    reconnect,
    cancel,
    retry,
    stateFor,
    attemptFor,
    isBusyElsewhere,
    ownsMcpAttempt: mcpAttempt !== null,
    attemptItemId: mcpAttempt?.itemId ?? managed?.itemId ?? null,
    managed,
    onManagedReport: setManagedReport,
    modal,
    openModal,
    closeModal,
  };
}
