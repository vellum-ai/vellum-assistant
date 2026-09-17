import { useEffect, useLayoutEffect, useRef } from "react";

import {
  useManagedOAuthConnect,
  type ManagedOAuthConnectStatus,
} from "@/hooks/use-managed-oauth-connect";

export interface ManagedConnectReport {
  status: ManagedOAuthConnectStatus;
  errorMessage: string | null;
}

export interface ManagedConnectControllerProps {
  /** The local assistant the connection is made for. */
  assistantId: string;
  providerKey: string;
  /** Provider name for the failure copy the hook composes. */
  providerLabel: string;
  /**
   * The customer's own host, for a per-tenant provider whose OAuth endpoints
   * do not live on one global domain. Absent for every other provider.
   */
  tenantHost?: string;
  /** Bumped to start the authorization again after a failure. */
  restartToken: number;
  onReport: (report: ManagedConnectReport) => void;
}

/**
 * One managed-OAuth attempt, given a place to live.
 *
 * `useManagedOAuthConnect` subscribes to `storage` events, deep links and a
 * connections poll for as long as it is mounted, so a list of forty
 * integrations cannot hold one per row. The page mounts exactly one of these,
 * for the provider being connected right now, and unmounts it when the attempt
 * ends. Unmounting is the cancel: the hook drops its attempt on the way out,
 * so reopening the provider offers Connect rather than a wait nothing ends.
 *
 * Renders nothing. The attempt's progress goes back to the page through
 * `onReport`, which draws it inside the tile the user clicked.
 */
export function ManagedConnectController({
  assistantId,
  providerKey,
  providerLabel,
  tenantHost,
  restartToken,
  onReport,
}: ManagedConnectControllerProps) {
  const { connect, dismiss, status, errorMessage } = useManagedOAuthConnect({
    assistantId,
    providerKey,
    providerLabel,
  });

  // The authorization window is opened by `connect`, and a browser only allows
  // that while the click that asked for it is still the transient activation.
  // A layout effect commits inside the click's own task; a passive effect can
  // be deferred past it.
  const connectRef = useRef(connect);
  const tenantHostRef = useRef(tenantHost);
  useLayoutEffect(() => {
    connectRef.current = connect;
    tenantHostRef.current = tenantHost;
  });
  useLayoutEffect(() => {
    connectRef.current(undefined, tenantHostRef.current);
  }, [restartToken]);

  useEffect(() => dismiss, [dismiss]);

  useEffect(() => {
    onReport({ status, errorMessage });
  }, [errorMessage, onReport, status]);

  return null;
}
