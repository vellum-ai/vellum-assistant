/**
 * CSRF token management for Django-backed requests.
 *
 * The browser's cookie jar holds the CSRF token set by Django. Mutating
 * requests (POST, PUT, PATCH, DELETE) must send it back in the
 * `X-CSRFToken` header so Django's CSRF middleware can verify the request
 * wasn't forged.
 *
 * Reference: https://docs.djangoproject.com/en/5.1/howto/csrf/#acquiring-the-token-if-csrf-use-sessions-and-csrf-cookie-httponly-are-not-in-use
 */
import { getAllauthByClientV1AuthSession } from "@/generated/auth/sdk.gen";
import { isGatewayAuthMode } from "@/lib/auth/gateway-session";

const CSRF_COOKIE_NAME = import.meta.env.PROD
  ? "__Secure-csrftoken"
  : "csrftoken";

/**
 * Read the CSRF token from the browser cookie jar.
 *
 * When duplicate cookies exist (e.g. a stale host-specific cookie alongside
 * the domain cookie), return the last match to match Django's `SimpleCookie`
 * last-wins semantics.
 */
export function getCsrfToken(): string | undefined {
  // In Electron the `app://` scheme doesn't support cookies, so
  // `document.cookie` is always empty. Read from the preload bridge
  // which pulls the token from main's cache via sync IPC.
  const bridgeToken = window.vellum?.csrf?.getToken();
  if (bridgeToken) return bridgeToken;

  const match = document.cookie
    .split("; ")
    .findLast((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match?.split("=").slice(1).join("=");
}

function clearDuplicateCsrfCookies(): void {
  const matches = document.cookie
    .split("; ")
    .filter((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  if (matches.length > 1) {
    document.cookie = `${CSRF_COOKIE_NAME}=; path=/; max-age=0; secure`;
  }
}

let csrfBootstrap: Promise<void> | null = null;

export async function ensureCsrfCookie(): Promise<void> {
  if (isGatewayAuthMode()) return;

  clearDuplicateCsrfCookies();

  if (getCsrfToken()) return;

  if (!csrfBootstrap) {
    csrfBootstrap = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await getAllauthByClientV1AuthSession({
            path: { client: "browser" },
          });
          if (getCsrfToken()) return;
        } catch {
          console.warn(
            `CSRF cookie bootstrap failed (attempt ${attempt + 1}/2)`,
          );
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
    })().finally(() => {
      csrfBootstrap = null;
    });
  }
  await csrfBootstrap;
}
