import { client as internalClient } from "@/generated/api/client.gen.js";
import { client as platformClient } from "@/generated/api/client.gen.js";
import {
  notifyAssistantUnreachable,
  UNREACHABLE_STATUS_CODES,
} from "@/lib/assistants/unreachable-bus.js";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/csrf.js";
import { getActiveOrganizationIdForRequests } from "@/lib/organization/organization-state.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function requestInterceptor(request: Request) {
  const newRequest = new Request(request);
  const organizationId = getActiveOrganizationIdForRequests();

  if (organizationId) {
    newRequest.headers.set("Vellum-Organization-Id", organizationId);
  }

  if (MUTATING_METHODS.has(request.method)) {
    await ensureCsrfCookie();
    const csrfToken = getCsrfToken();
    if (csrfToken) {
      newRequest.headers.set("X-CSRFToken", csrfToken);
    }
  }

  return newRequest;
}

/**
 * Routes whose 502/503/504 responses are feature-level errors, not
 * pod-reachability signals. A 503 from `/stt/transcribe` means "no
 * STT provider configured", not "pod is down"; triggering the
 * connecting overlay would be a false positive. Likewise, a 502
 * from `/pro-upgrade-machine/` is a vembda PVC/machine resize
 * failure on a healthy pod — surfacing it as "Connecting to your
 * assistant" alongside the upgrade error toast is a confusing
 * double-error UX.
 *
 * `/hatch/` returns 503 when the `platform-hosted-enabled` flag is
 * off (Vellum-Cloud capacity gate, surfaced as a tailored "we're at
 * capacity" message); the chat-page auto-hatch path would otherwise
 * double-render the connecting overlay on top of that message.
 */
const FEATURE_ERROR_ROUTES = [
  "/connection-status/",
  "/hatch/",
  "/pro-upgrade-machine/",
  "/stt/",
];

export function responseInterceptor(response: Response) {
  // A 502/503/504 from any /v1/ endpoint almost always means the
  // assistant's runtime pod is unreachable (restarting, not yet
  // ready, crash looping). Surface it so the reachability hook can
  // show the connecting overlay even when the failing request isn't
  // the main SSE stream.
  //
  // Skip routes that return gateway-ish status codes for
  // feature-level reasons (e.g. STT provider not configured) and
  // the connection-status probe itself (re-entry → infinite loop).
  if (
    UNREACHABLE_STATUS_CODES.has(response.status) &&
    !FEATURE_ERROR_ROUTES.some((route) => response.url.includes(route))
  ) {
    notifyAssistantUnreachable();
  }
  return response;
}

for (const apiClient of [internalClient, platformClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
  apiClient.interceptors.response.use(responseInterceptor);
}
