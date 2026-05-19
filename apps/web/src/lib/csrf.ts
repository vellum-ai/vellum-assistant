import { getAllauthByClientV1AuthSession } from "@/generated/auth/sdk.gen.js";

const CSRF_COOKIE_NAME =
  process.env.NEXT_PUBLIC_CSRF_COOKIE_NAME ?? "csrftoken";

/**
 * Read the CSRF token from the browser cookie jar.
 *
 * When duplicate cookies exist (e.g. a stale host-specific cookie alongside the
 * `.vellum.ai` domain cookie), we return the **last** match. Django's cookie
 * parser (`SimpleCookie.load`) also uses last-wins semantics, so this ensures
 * the value we send in the POST body / header matches the one Django reads from
 * the `Cookie` header.
 */
export function getCsrfToken(): string | undefined {
  const match = document.cookie
    .split("; ")
    .findLast((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match?.split("=").slice(1).join("=");
}

/**
 * Remove stale host-specific CSRF cookies that conflict with the shared
 * `.vellum.ai` domain cookie. When the browser has two cookies with the same
 * name but different domain scopes, JS `.find()` and Django's `SimpleCookie`
 * may pick different values, causing CSRF verification failures.
 *
 * Clearing without a `domain` attribute targets the host-specific cookie;
 * the `.vellum.ai` domain cookie is unaffected.
 */
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
            `CSRF cookie bootstrap failed (attempt ${attempt + 1}/2)`
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
