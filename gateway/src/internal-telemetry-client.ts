// Authenticated POST to a daemon internal-telemetry route: service-token
// auth, JSON body, bounded timeout, response body consumed so the connection
// is released. Callers own the failure posture (re-queue vs drop) — this
// helper only performs the transport.

import { buildUpstreamUrl } from "@vellumai/assistant-client";

import { mintServiceToken } from "./auth/token-exchange.js";
import { fetchImpl as defaultFetchImpl } from "./fetch.js";

const POST_TIMEOUT_MS = 10_000;

export async function postInternalTelemetry(args: {
  /** Daemon runtime base URL (`config.assistantRuntimeBaseUrl`). */
  baseUrl: string;
  /** Route path, e.g. `/v1/internal/telemetry/watchdog`. */
  path: string;
  body: unknown;
  /** Injectable for tests. Defaults to the shared fetch wrapper. */
  fetchImpl?: typeof defaultFetchImpl;
  /** Injectable for tests. Defaults to minting a real service token. */
  mintToken?: () => string;
}): Promise<Response> {
  const url = buildUpstreamUrl(args.baseUrl, args.path);
  const doFetch = args.fetchImpl ?? defaultFetchImpl;
  const mintToken = args.mintToken ?? mintServiceToken;

  const resp = await doFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mintToken()}`,
    },
    body: JSON.stringify(args.body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  await resp.text(); // release the connection
  return resp;
}
