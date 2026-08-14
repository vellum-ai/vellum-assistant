/**
 * Wire contract between the daemon (client) and the route host subprocess
 * (server), carried over the shared IPC framing (`@vellumai/ipc-server-utils`) on the
 * Unix socket at `$VELLUM_WORKSPACE_DIR/procs/routes/routes.sock`.
 *
 * One request/response pair per route invocation, correlated by the envelope
 * `id`. Request/response **bodies** are not embedded in the JSON envelope —
 * they travel as the single binary follow-frame the framing already supports
 * (`content-length` header + one binary frame), so a body is streamed as bytes
 * rather than base64'd through JSON.
 */

import type { PluginRouteActorContext } from "../plugin-api/route-context.js";
import type { VerifiedPeerOperationContext } from "../plugin-api/verified-peer-context.js";
import type {
  RouteHostBrokerRequest,
  RouteHostBrokerResult,
} from "./route-host-broker.js";

/** Subprocess name → its `procs/<name>/` runtime dir, socket, and PID file. */
export const ROUTE_HOST_PROC_NAME = "routes";

/** The one IPC method the route host serves. */
export const ROUTE_INVOKE_METHOD = "invoke";

/** Cancel one in-flight invocation after its caller disconnects. */
export const ROUTE_CANCEL_METHOD = "cancel";

/** Restricted host API call from the route host to the main process. */
export const ROUTE_BROKER_METHOD = "broker";

export interface SerializedPluginRouteContext {
  readonly pluginId: string;
  readonly actor: PluginRouteActorContext;
  readonly requestId: string;
  readonly verifiedPeer: VerifiedPeerOperationContext | null;
}

/**
 * Request metadata (daemon → host). The resolved handler file is passed in —
 * the daemon does path resolution and 404s, so the host never touches route
 * resolution and never runs for an unknown path. The request body, if any,
 * rides in the binary follow-frame.
 */
export interface RouteInvokeParams {
  /** Absolute path to the resolved handler module. */
  readonly filePath: string;
  /** HTTP method whose exported handler should run. */
  readonly method: string;
  /** Full synthetic request URL (`http://localhost/v1/x/<path>?<query>`). */
  readonly url: string;
  /** Request header entries as `[name, value]` pairs (preserves duplicates). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly pluginContext?: SerializedPluginRouteContext | null;
  /** Source tree to reload as one unit. Production callers provide this. */
  readonly sourceRoot?: string;
}

/** Internal daemon-to-host invocation fields. */
export interface RouteInvokeWireParams extends RouteInvokeParams {
  readonly sourceRoot: string;
  readonly brokerCapability: string | null;
}

export interface RouteCancelParams {
  readonly requestId: string;
}

export interface RouteBrokerParams {
  readonly invokeId: string;
  readonly capability: string;
  readonly request: unknown;
}

export type { RouteHostBrokerRequest, RouteHostBrokerResult };

/**
 * Response metadata (host → daemon). The response body, if any, rides in the
 * binary follow-frame. On a handler throw / load failure the host replies with
 * the envelope's `error` field instead, which the daemon maps to a 500.
 */
export interface RouteInvokeResult {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}
