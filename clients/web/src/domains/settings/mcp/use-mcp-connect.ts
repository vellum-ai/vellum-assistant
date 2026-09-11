import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import {
  CONNECTION_POLL_INTERVAL_MS,
  CONNECTION_POLL_WINDOW_MS,
} from "@/lib/auth/oauth-connect-timing";
import { mcpCancellationAttemptId } from "@/lib/backwards-compat/mcp-auth-cancellation";
import { captureError } from "@/lib/sentry/capture-error";
import { openUrlFinishedListener, openUrlInNewTab } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

import { mcpLifecycleState } from "../integration-items";
import {
  cancelMcpAuth,
  fetchMcpServers,
  pollMcpAuthStatus,
  startMcpAuth,
} from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";

interface McpConnectAttempt {
  operationId: string;
  serverId: string;
  displayName: string;
  startedAt: number;
  phase: "starting" | "authorizing" | "waiting" | "connecting" | "error";
  attemptId?: string;
  error?: string;
}

export function useMcpConnect(assistantId: string) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<McpConnectAttempt | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const activeOperation = useRef<string | null>(null);
  const ownedPopup = useRef<Window | null>(null);
  const pendingPreparation = useRef<{
    operationId: string;
    run: () => Promise<string | void>;
  } | null>(null);

  const stopWaiting = useCallback(() => {
    activeOperation.current = null;
    pendingPreparation.current = null;
    ownedPopup.current?.close();
    ownedPopup.current = null;
    setAttempt(null);
    setIsCancelling(false);
  }, []);

  useEffect(() => {
    stopWaiting();
    return () => {
      activeOperation.current = null;
      pendingPreparation.current = null;
      ownedPopup.current?.close();
      ownedPopup.current = null;
    };
  }, [assistantId, stopWaiting]);

  const awaitingAuthorization =
    attempt?.phase === "authorizing" || attempt?.phase === "waiting";
  const authStatus = useQuery({
    queryKey: mcpQueryKeys.auth(assistantId, attempt?.operationId ?? ""),
    queryFn: () => pollMcpAuthStatus(assistantId, attempt!.serverId),
    enabled: awaitingAuthorization,
    refetchInterval: awaitingAuthorization ? CONNECTION_POLL_INTERVAL_MS : false,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
  });

  const runtime = useQuery({
    queryKey: mcpQueryKeys.list(assistantId),
    queryFn: () => fetchMcpServers(assistantId),
    enabled: attempt?.phase === "connecting",
    refetchInterval:
      attempt?.phase === "connecting" ? CONNECTION_POLL_INTERVAL_MS : false,
    staleTime: 0,
    retry: 1,
  });

  useEffect(() => {
    if (
      !attempt ||
      !awaitingAuthorization ||
      activeOperation.current !== attempt.operationId ||
      !authStatus.data
    ) {
      return;
    }
    const status = authStatus.data;
    if (attempt.attemptId && status.attempt_id !== attempt.attemptId) {
      setAttempt({
        ...attempt,
        attemptId: undefined,
        phase: "error",
        error: t("mcpConnect.superseded"),
      });
    } else if (status.status === "complete") {
      ownedPopup.current?.close();
      ownedPopup.current = null;
      setAttempt({ ...attempt, attemptId: undefined, phase: "connecting" });
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.list(assistantId),
      });
    } else if (status.status === "error" || status.status === "cancelled") {
      setAttempt({
        ...attempt,
        phase: "error",
        error:
          status.error?.replaceAll(attempt.serverId, attempt.displayName) ??
          t("mcpConnect.authorizationFailed"),
      });
    }
  }, [
    assistantId,
    attempt,
    authStatus.data,
    awaitingAuthorization,
    queryClient,
    t,
  ]);

  useEffect(() => {
    if (
      attempt?.phase !== "connecting" ||
      !runtime.data ||
      runtime.isFetching
    ) {
      return;
    }
    const server = runtime.data.servers.find(
      (entry) => entry.id === attempt.serverId,
    );
    if (server && mcpLifecycleState(server) === "connected") {
      stopWaiting();
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.details(assistantId),
      });
    } else if (server && mcpLifecycleState(server) === "error") {
      setAttempt({
        ...attempt,
        phase: "error",
        error: t("mcpConnect.runtimeFailed"),
      });
    }
  }, [
    assistantId,
    attempt,
    queryClient,
    runtime.data,
    runtime.isFetching,
    stopWaiting,
    t,
  ]);

  useEffect(() => {
    if (!attempt || attempt.phase === "error") {
      return;
    }
    const error = awaitingAuthorization
      ? authStatus.error
      : attempt.phase === "connecting"
        ? runtime.error
        : null;
    if (error) {
      captureError(error, { context: "mcp.connect.poll" });
      setAttempt({
        ...attempt,
        phase: "error",
        error: t("mcpConnect.pollFailed"),
      });
    }
  }, [attempt, authStatus.error, awaitingAuthorization, runtime.error, t]);

  useEffect(() => {
    if (!attempt || attempt.phase === "error") {
      return;
    }
    const timer = setTimeout(
      () => {
        if (activeOperation.current !== attempt.operationId) {
          return;
        }
        ownedPopup.current?.close();
        ownedPopup.current = null;
        setAttempt(
          (current) =>
            current && {
              ...current,
              phase: "error",
              error: t("mcpConnect.timedOut"),
            },
        );
      },
      Math.max(0, attempt.startedAt + CONNECTION_POLL_WINDOW_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [attempt, t]);

  const handleBrowserFinished = useCallback(
    (operationId: string) => {
      if (activeOperation.current !== operationId) {
        return;
      }
      setAttempt((current) =>
        current?.operationId === operationId && current.phase === "authorizing"
          ? { ...current, phase: "waiting" }
          : current,
      );
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.auth(assistantId, operationId),
      });
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.list(assistantId),
      });
    },
    [assistantId, queryClient],
  );

  useEffect(() => {
    const popup = ownedPopup.current;
    if (attempt?.phase !== "authorizing" || !popup) {
      return;
    }
    const checkClosed = () => {
      if (popup.closed && activeOperation.current === attempt.operationId) {
        // COOP can sever the handle before authorization finishes. Keep polling.
        handleBrowserFinished(attempt.operationId);
      }
    };
    checkClosed();
    const interval = setInterval(checkClosed, 500);
    return () => clearInterval(interval);
  }, [attempt?.operationId, attempt?.phase, handleBrowserFinished]);

  // TQ's focus manager handles app resume; native browser closure also refetches.
  useEffect(() => {
    const operationId = attempt?.operationId;
    if (!operationId) {
      return;
    }
    return openUrlFinishedListener(() => handleBrowserFinished(operationId));
  }, [attempt?.operationId, handleBrowserFinished]);

  const connect = useCallback(
    (
      serverId: string,
      prepare?: () => Promise<string | void>,
      displayName = serverId,
    ) => {
      if (
        activeOperation.current &&
        ((attempt?.phase !== "error" && attempt?.phase !== "waiting") ||
          activeOperation.current !== attempt.operationId)
      ) {
        return;
      }
      const operationId = crypto.randomUUID();
      activeOperation.current = operationId;
      ownedPopup.current?.close();
      ownedPopup.current = null;
      setIsCancelling(false);
      pendingPreparation.current = prepare
        ? { operationId, run: prepare }
        : null;
      let next: McpConnectAttempt = {
        operationId,
        serverId,
        displayName,
        startedAt: Date.now(),
        phase: "starting",
      };
      setAttempt(next);
      const shell = isNativePlatform() || isElectron();
      const popup = shell
        ? null
        : window.open("", "_blank", "width=500,height=600");
      if (!shell && !popup) {
        setAttempt({
          ...next,
          phase: "error",
          error: t("mcpConnect.popupBlocked"),
        });
        return;
      }
      if (popup) {
        popup.opener = null;
        ownedPopup.current = popup;
      }
      const stillCurrent = () =>
        activeOperation.current === operationId &&
        Date.now() < next.startedAt + CONNECTION_POLL_WINDOW_MS;
      void (async () => {
        try {
          const preparedServerId = await prepare?.();
          if (pendingPreparation.current?.operationId === operationId) {
            pendingPreparation.current = null;
          }
          if (!stillCurrent()) {
            return;
          }
          if (preparedServerId) {
            next = { ...next, serverId: preparedServerId };
            setAttempt(next);
          }
          const result = await startMcpAuth(assistantId, next.serverId);
          if (!stillCurrent()) {
            return;
          }
          const attemptId = mcpCancellationAttemptId(result);
          if (result.already_authenticated) {
            popup?.close();
            ownedPopup.current = null;
            setAttempt({ ...next, phase: "connecting" });
            return;
          }
          const url = new URL(result.auth_url);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("Unsupported MCP authorization URL protocol");
          }
          setAttempt({ ...next, attemptId, phase: "authorizing" });
          if (popup) {
            if (!popup.closed) {
              popup.location.replace(url.href);
            }
          } else if (!(await openUrlInNewTab(url.href))) {
            throw new Error("MCP authorization window was blocked");
          }
        } catch (error) {
          popup?.close();
          if (stillCurrent()) {
            ownedPopup.current = null;
            captureError(error, { context: "mcp.connect.start" });
            setAttempt(
              (current) =>
                current && {
                  ...current,
                  phase: "error",
                  error: t("mcpConnect.startFailed"),
                },
            );
          }
        }
      })();
    },
    [assistantId, attempt?.phase, attempt?.operationId, t],
  );

  const dismiss = useCallback(async () => {
    if (!attempt?.attemptId || attempt.phase === "connecting") {
      stopWaiting();
      return;
    }
    const operationId = attempt.operationId;
    setIsCancelling(true);
    try {
      const result = await cancelMcpAuth(
        assistantId,
        attempt.serverId,
        attempt.attemptId,
      );
      if (activeOperation.current !== operationId) {
        return;
      }
      if (!result.cancelled) {
        setAttempt({
          ...attempt,
          phase: "error",
          attemptId: undefined,
          error: t("mcpConnect.cancelSuperseded"),
        });
      } else {
        stopWaiting();
      }
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.list(assistantId),
      });
    } catch (error) {
      if (activeOperation.current === operationId) {
        captureError(error, { context: "mcp.connect.cancel" });
        setAttempt({ ...attempt, error: t("mcpConnect.cancelFailed") });
      }
    } finally {
      if (activeOperation.current === operationId) {
        setIsCancelling(false);
      }
    }
  }, [assistantId, attempt, queryClient, stopWaiting, t]);

  return {
    attempt,
    isBusy: Boolean(
      attempt && attempt.phase !== "error" && attempt.phase !== "waiting",
    ),
    connect,
    retry: () => {
      if (attempt) {
        connect(
          attempt.serverId,
          pendingPreparation.current?.run,
          attempt.displayName,
        );
      }
    },
    dismiss,
    stopWaiting,
    isCancelling,
    canCancel: Boolean(attempt?.attemptId && attempt.phase !== "connecting"),
  };
}
