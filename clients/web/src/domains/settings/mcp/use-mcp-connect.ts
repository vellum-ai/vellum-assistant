import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTranslation } from "@/i18n";
import {
  CONNECTION_POLL_INTERVAL_MS,
  CONNECTION_POLL_WINDOW_MS,
} from "@/lib/auth/oauth-connect-timing";
import { captureError } from "@/lib/sentry/capture-error";
import { openExternalUrl, openUrlFinishedListener } from "@/runtime/browser";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform } from "@/runtime/native-auth";

import { fetchMcpServers, pollMcpAuthStatus, startMcpAuth } from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";

interface McpConnectAttempt {
  operationId: string;
  serverId: string;
  displayName: string;
  startedAt: number;
  phase: "starting" | "authorizing" | "waiting" | "connecting" | "error";
  error?: string;
}

type PrepareMcpConnection = () => Promise<string | null | void>;

export function mcpRuntimeIsReady(
  servers: Array<{ id: string; status: string }>,
  serverId: string,
): boolean {
  return servers.some(
    (server) => server.id === serverId && server.status === "connected",
  );
}

export function settledMcpPollError(
  error: Error | null,
  isFetching: boolean,
): Error | null {
  return isFetching ? null : error;
}

export function useMcpConnect(assistantId: string) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<McpConnectAttempt | null>(null);
  const activeOperation = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pendingPreparation = useRef<{
    operationId: string;
    run: PrepareMcpConnection;
  } | null>(null);

  const stopWaiting = useCallback(() => {
    activeOperation.current = null;
    pendingPreparation.current = null;
    popupRef.current?.close();
    popupRef.current = null;
    setAttempt(null);
  }, []);

  useEffect(() => {
    stopWaiting();
    return () => {
      activeOperation.current = null;
      pendingPreparation.current = null;
      popupRef.current?.close();
      popupRef.current = null;
    };
  }, [assistantId, stopWaiting]);

  const awaitingAuthorization =
    attempt?.phase === "authorizing" || attempt?.phase === "waiting";
  const authStatus = useQuery({
    queryKey: mcpQueryKeys.auth(assistantId, attempt?.operationId ?? ""),
    queryFn: () => pollMcpAuthStatus(assistantId, attempt!.serverId),
    enabled: awaitingAuthorization,
    refetchInterval: awaitingAuthorization
      ? CONNECTION_POLL_INTERVAL_MS
      : false,
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
    if (authStatus.data.status === "complete") {
      popupRef.current?.close();
      popupRef.current = null;
      setAttempt({ ...attempt, phase: "connecting" });
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.list(assistantId),
      });
    } else if (authStatus.data.status === "error") {
      setAttempt({
        ...attempt,
        phase: "error",
        error:
          authStatus.data.error?.replaceAll(
            attempt.serverId,
            attempt.displayName,
          ) ?? t("mcpConnect.authorizationFailed"),
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
      activeOperation.current !== attempt.operationId ||
      !runtime.data ||
      runtime.isFetching
    ) {
      return;
    }
    if (mcpRuntimeIsReady(runtime.data.servers, attempt.serverId)) {
      stopWaiting();
      void queryClient.invalidateQueries({
        queryKey: mcpQueryKeys.details(assistantId),
      });
    }
  }, [
    assistantId,
    attempt,
    queryClient,
    runtime.data,
    runtime.isFetching,
    stopWaiting,
  ]);

  useEffect(() => {
    if (!attempt || attempt.phase === "error") {
      return;
    }
    const error = awaitingAuthorization
      ? settledMcpPollError(authStatus.error, authStatus.isFetching)
      : attempt.phase === "connecting"
      ? settledMcpPollError(runtime.error, runtime.isFetching)
      : null;
    if (!error) {
      return;
    }
    captureError(error, { context: "mcp.connect.poll" });
    setAttempt({
      ...attempt,
      phase: "error",
      error: t("mcpConnect.pollFailed"),
    });
  }, [
    attempt,
    authStatus.error,
    authStatus.isFetching,
    awaitingAuthorization,
    runtime.error,
    runtime.isFetching,
    t,
  ]);

  useEffect(() => {
    if (!attempt || attempt.phase === "error") {
      return;
    }
    const timer = setTimeout(() => {
      if (activeOperation.current !== attempt.operationId) {
        return;
      }
      popupRef.current?.close();
      popupRef.current = null;
      setAttempt((current) =>
        current?.operationId === attempt.operationId
          ? { ...current, phase: "error", error: t("mcpConnect.timedOut") }
          : current,
      );
    }, Math.max(0, attempt.startedAt + CONNECTION_POLL_WINDOW_MS - Date.now()));
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
    const popup = popupRef.current;
    if (attempt?.phase !== "authorizing" || !popup) {
      return;
    }
    const checkClosed = () => {
      if (popup.closed) {
        handleBrowserFinished(attempt.operationId);
      }
    };
    const interval = setInterval(checkClosed, 500);
    return () => clearInterval(interval);
  }, [attempt?.operationId, attempt?.phase, handleBrowserFinished]);

  useEffect(() => {
    const operationId = attempt?.operationId;
    const phase = attempt?.phase;
    if (!operationId || phase === "connecting" || phase === "error") {
      return;
    }
    return openUrlFinishedListener(() => handleBrowserFinished(operationId));
  }, [attempt?.operationId, attempt?.phase, handleBrowserFinished]);

  const connect = useCallback(
    (
      serverId: string,
      prepare?: PrepareMcpConnection,
      displayName = serverId,
    ) => {
      if (activeOperation.current && attempt?.phase !== "error") {
        return;
      }

      const operationId = crypto.randomUUID();
      activeOperation.current = operationId;
      popupRef.current?.close();
      popupRef.current = null;
      pendingPreparation.current = prepare
        ? { operationId, run: prepare }
        : null;
      const next: McpConnectAttempt = {
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
        popupRef.current = popup;
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
          if (preparedServerId === null) {
            popup?.close();
            popupRef.current = null;
            activeOperation.current = null;
            setAttempt(null);
            return;
          }
          const resolvedAttempt = preparedServerId
            ? { ...next, serverId: preparedServerId }
            : next;
          if (preparedServerId) {
            setAttempt(resolvedAttempt);
          }
          const result = await startMcpAuth(
            assistantId,
            resolvedAttempt.serverId,
          );
          if (!stillCurrent()) {
            return;
          }
          if (result.already_authenticated) {
            popup?.close();
            popupRef.current = null;
            setAttempt({ ...resolvedAttempt, phase: "connecting" });
            return;
          }
          const url = new URL(result.auth_url);
          if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("Unsupported MCP authorization URL protocol");
          }
          setAttempt({ ...resolvedAttempt, phase: "authorizing" });
          if (popup) {
            if (!popup.closed) {
              popup.location.replace(url.href);
            }
          } else {
            await openExternalUrl(url.href);
          }
        } catch (error) {
          popup?.close();
          if (stillCurrent()) {
            popupRef.current = null;
            captureError(error, { context: "mcp.connect.start" });
            setAttempt((current) =>
              current?.operationId === operationId
                ? {
                    ...current,
                    phase: "error",
                    error: t("mcpConnect.startFailed"),
                  }
                : current,
            );
          }
        }
      })();
    },
    [assistantId, attempt?.phase, t],
  );

  return {
    attempt,
    isBusy: Boolean(attempt && attempt.phase !== "error"),
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
    stopWaiting,
  };
}
