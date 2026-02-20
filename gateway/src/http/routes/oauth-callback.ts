import type { GatewayConfig } from "../../config.js";
import { getLogger } from "../../logger.js";
import { forwardOAuthCallback } from "../../runtime/client.js";

const log = getLogger("oauth-callback");

export function createOAuthCallbackHandler(config: GatewayConfig) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (!state) {
      return new Response(renderErrorPage("Missing state parameter"), {
        status: 400,
        headers: { "Content-Type": "text/html" },
      });
    }

    try {
      const response = await forwardOAuthCallback(
        config,
        state,
        code || undefined,
        error || undefined,
      );

      if (response.status >= 200 && response.status < 300) {
        return new Response(renderSuccessPage(), {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response(
        renderErrorPage("Authorization failed. Please try again."),
        { status: 400, headers: { "Content-Type": "text/html" } },
      );
    } catch (err) {
      log.error({ err }, "Failed to forward OAuth callback to runtime");
      return new Response(
        renderErrorPage("Authorization failed. Please try again."),
        { status: 502, headers: { "Content-Type": "text/html" } },
      );
    }
  };
}

function renderSuccessPage(): string {
  return `<!DOCTYPE html><html><head><title>Authorization Successful</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}</style></head><body><div><h1>Authorization Successful</h1><p>You can close this tab and return to the app.</p></div></body></html>`;
}

function renderErrorPage(message: string): string {
  return `<!DOCTYPE html><html><head><title>Authorization Failed</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}div{text-align:center;padding:2rem;background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}</style></head><body><div><h1>Authorization Failed</h1><p>${message}</p></div></body></html>`;
}
