import {
  authorizePairedForwardHeaders,
  resolveGatewayProxyTarget,
  resolvePairedGatewayProxyTarget,
  sanitizePairedForwardHeaders,
  type PairedGuardianTokenProvider,
} from "@vellumai/local-mode";

import {
  fetchForwardPlanWithRetry,
  type ForwardFetchRetryOptions,
} from "./platform-forward";

/**
 * Planning and execution for the gateway data-plane proxies: the loopback
 * `/assistant/__gateway/{port}/*` forward and the paired-remote
 * `/assistant/__gateway-paired/{assistantId}/*` forward.
 *
 * Lives in its own file — like `app-protocol.ts` — so the URL/header logic is
 * testable without importing `src/main/index.ts` (which evaluates the full
 * lifecycle wiring at module load) or mocking Electron's `net`. The caller in
 * `index.ts` supplies `net.fetch`; `executeGatewayForwardPlan` turns a
 * `forward` plan into a single fetch and returns its streaming `Response`
 * verbatim.
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
      /**
       * Remote hops (paired gateways reached over a tunnel) collapse
       * transport failures into the structured proxy 502 with a bounded
       * GET/HEAD retry; loopback hops propagate rejections untouched.
       */
      remote: false;
    }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
      remote: true;
      /** Paired assistant whose guardian bearer the trusted host injects. */
      assistantId: string;
      /** Imported gateway URL bound to that assistant's guardian bearer. */
      runtimeUrl: string;
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
        remote: false,
      };
    }
  }
}

/**
 * Resolve a renderer request to a paired-gateway proxy plan
 * (`/assistant/__gateway-paired/{assistantId}/*`), reusing the shared
 * lockfile-pairing decision so the security boundary is defined once for every
 * host: only assistants the user actually imported are reachable.
 *
 * On `forward`, renderer-controlled authorization and browser-ambient headers
 * (`Origin`, `Referer`, `Cookie`, `Sec-Fetch-*`) are stripped via the shared
 * `sanitizePairedForwardHeaders`. The trusted main process installs the
 * paired assistant's guardian bearer before executing the plan.
 *
 * Electron's WebRequest boundary verifies the requesting frame before this
 * planner runs. The lockfile pairing then constrains the remote destination. A
 * compromised trusted renderer retains access through the running proxy but
 * cannot read or reuse the guardian credential outside it.
 */
export function planPairedGatewayForward(
  request: GatewayForwardRequest,
  getTargets: () => Map<string, string>,
): GatewayForwardPlan {
  const url = new URL(request.url);
  const decision = resolvePairedGatewayProxyTarget(
    url.pathname + url.search,
    getTargets,
  );

  switch (decision.kind) {
    case "pass":
      return { kind: "pass" };
    case "reject":
      return decision;
    case "forward": {
      const headers = new Headers(request.headers);
      sanitizePairedForwardHeaders(headers);
      return {
        kind: "forward",
        url: decision.url,
        method: request.method,
        headers,
        hasBody: request.method !== "GET" && request.method !== "HEAD",
        remote: true,
        assistantId: decision.assistantId,
        runtimeUrl: decision.runtimeUrl,
      };
    }
  }
}

/** Resolve and install the host-owned bearer required by a paired plan. */
export async function authorizePairedGatewayForwardPlan(
  plan: GatewayForwardPlan,
  getGuardianToken: PairedGuardianTokenProvider,
): Promise<GatewayForwardPlan> {
  if (plan.kind !== "forward" || !plan.remote) {
    return plan;
  }
  const result = await authorizePairedForwardHeaders(
    plan.assistantId,
    plan.runtimeUrl,
    plan.headers,
    getGuardianToken,
  );
  if (!result.ok) {
    return { kind: "reject", status: result.status, message: result.error };
  }
  return plan;
}

/** Injectable stand-in for Electron's `net.fetch`. */
export type GatewayForwardFetcher = (
  url: string,
  init: RequestInit & { duplex?: "half" },
) => Promise<Response>;

/**
 * Turn a gateway forward plan into its effect: `null` on `pass` so the caller
 * serves the request as a static asset, otherwise the plan's rejection or a
 * single fetch whose streaming `Response` is returned verbatim, preserving
 * SSE and chunked transfers (Electron's `stream: true` scheme privilege).
 * The plan owns the allowlist and header decisions.
 *
 * Remote (paired) hops ride a tunnel that can drop mid-session, so their
 * transport failures become the structured proxy 502 (with one in-proxy
 * retry for transient GET/HEAD failures) instead of a rejected promise the
 * renderer would render as a raw `net::ERR_*` string. No overall response
 * timeout is applied: SSE streams over this forward are long-lived.
 */
export function executeGatewayForwardPlan(
  plan: GatewayForwardPlan,
  request: Pick<Request, "body">,
  fetcher: GatewayForwardFetcher,
  retryOptions: ForwardFetchRetryOptions = {},
): Promise<Response> | Response | null {
  switch (plan.kind) {
    case "pass":
      return null;
    case "reject":
      return new Response(plan.message, { status: plan.status });
    case "forward": {
      const doFetch = () =>
        fetcher(plan.url, {
          method: plan.method,
          headers: plan.headers,
          body: plan.hasBody ? request.body : undefined,
          // Stream the request body instead of buffering it; required by the
          // fetch spec whenever a `ReadableStream` body is supplied.
          ...(plan.hasBody ? { duplex: "half" as const } : {}),
          redirect: "manual",
        });
      if (!plan.remote) {
        return doFetch();
      }
      return fetchForwardPlanWithRetry(plan, doFetch, {
        retries: 1,
        onError: (err, attempt) => {
          console.error(
            `[gateway-forward] fetch failed (attempt ${attempt + 1}) for ${plan.method} ${plan.url}:`,
            err,
          );
        },
        ...retryOptions,
      });
    }
  }
}
