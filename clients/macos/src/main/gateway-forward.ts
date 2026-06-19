import { resolveGatewayProxyTarget } from "@vellumai/local-mode";

/**
 * Pure planning for the gateway data-plane proxy (`/assistant/__gateway/{port}/*`).
 *
 * Lives in its own file — like `app-protocol.ts` — so the URL/header logic is
 * testable without importing `src/main/index.ts` (which evaluates the full
 * lifecycle wiring at module load) or mocking Electron's `net`. The caller in
 * `index.ts` turns a `forward` plan into a single `net.fetch` and returns its
 * streaming `Response` verbatim.
 */
export type GatewayForwardPlan =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
    };

export interface GatewayForwardRequest {
  url: string;
  method: string;
  headers: Headers;
}

/**
 * Resolve a renderer request to a gateway-proxy plan, reusing the shared
 * lockfile-allowlist decision so the security boundary is defined once for
 * both this handler and the Vite dev proxy.
 *
 * On `forward`, the request's `Origin` is rewritten to the gateway's own
 * loopback origin. The gateway token route (`/auth/token`) only accepts
 * loopback web origins (`http(s)://localhost|127.0.0.1`) as a CSRF defense
 * against arbitrary web pages; the renderer issues this request from the
 * packaged app's `app://vellum.ai` origin, but the main process is itself the
 * trusted loopback client making the hop — exactly as the dev server's browser
 * presents `http://localhost:<port>`. Without the rewrite the gateway rejects
 * the packaged app's origin with 403. Only `Origin` is gated, so the remaining
 * headers (notably the guardian `Authorization` bearer) pass through unchanged.
 */
export function planGatewayForward(
  request: GatewayForwardRequest,
  getAllowedPorts: () => Set<number>,
): GatewayForwardPlan {
  const url = new URL(request.url);
  const decision = resolveGatewayProxyTarget(
    url.pathname + url.search,
    getAllowedPorts,
  );

  switch (decision.kind) {
    case "pass":
      return { kind: "pass" };
    case "invalid-port":
      return {
        kind: "reject",
        status: 400,
        message: "Port must be between 1024 and 65535",
      };
    case "forbidden-port":
      return {
        kind: "reject",
        status: 403,
        message: "Gateway port is not active in lockfile",
      };
    case "forward": {
      const { port, path: targetPath } = decision.target;
      const headers = new Headers(request.headers);
      headers.set("origin", `http://127.0.0.1:${port}`);
      return {
        kind: "forward",
        url: `http://127.0.0.1:${port}${targetPath}`,
        method: request.method,
        headers,
        hasBody: request.method !== "GET" && request.method !== "HEAD",
      };
    }
  }
}

export interface GatewayForwardEffect {
  url: string;
  init: {
    method: string;
    headers: Headers;
    body?: ArrayBuffer;
    redirect: "manual";
  };
}

/**
 * Resolve a `forward` plan into the concrete `net.fetch` arguments, buffering
 * the request body into a finite `ArrayBuffer` rather than streaming it.
 *
 * The renderer reaches local gateways over plain-HTTP loopback
 * (`http://127.0.0.1:<port>`), and Chromium's network stack cannot upload a
 * streamed (`duplex: "half"`) request body over cleartext HTTP/1.1 — a
 * non-trivial body (an image or file attachment) stalls indefinitely while
 * waiting to send, so the upload spins forever. A buffered body carries an
 * explicit `Content-Length` and uploads normally. The gateway buffers the body
 * upstream regardless, so nothing on this hop needs request streaming.
 */
export async function buildGatewayForwardEffect(
  plan: Extract<GatewayForwardPlan, { kind: "forward" }>,
  request: { arrayBuffer: () => Promise<ArrayBuffer> },
): Promise<GatewayForwardEffect> {
  const body = plan.hasBody ? await request.arrayBuffer() : undefined;
  return {
    url: plan.url,
    init: {
      method: plan.method,
      headers: plan.headers,
      body,
      redirect: "manual",
    },
  };
}
