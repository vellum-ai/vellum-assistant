import type { GatewayConfig } from "../../config.js";
import { mintServiceToken } from "../../auth/token-exchange.js";
import { fetchImpl } from "../../fetch.js";
import { desktopExtensionSecurity } from "../../desktop/desktop-extension-security.js";
import { readLimitedBody } from "../read-limited-body.js";
import { resolveLocalGuardianPrincipalId } from "./pair.js";

export function createDesktopBrowserHandler(
  config: GatewayConfig,
  deps = {
    fetch: fetchImpl,
    guardian: resolveLocalGuardianPrincipalId,
    serviceToken: mintServiceToken,
    acceptsCapability: (token: unknown) =>
      desktopExtensionSecurity.accepts(token),
  },
) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const bridge = path === "/v1/desktop/browser/bridge";
    let body: string | undefined;
    if (bridge) {
      if (req.headers.has("origin")) {
        return new Response("Native desktop client required", { status: 403 });
      }
      const limited = await readLimitedBody(
        req,
        Math.min(config.maxWebhookPayloadBytes, 4 * 1024 * 1024),
      );
      if (limited.status !== "ok") {
        return new Response("Invalid desktop message", { status: 413 });
      }
      try {
        const message = JSON.parse(limited.text);
        if (!deps.acceptsCapability(message?.token)) {
          return new Response("Invalid desktop browser capability", {
            status: 403,
          });
        }
        body = JSON.stringify({
          ...message,
          guardian: await deps.guardian(),
        });
      } catch {
        return new Response("Invalid desktop message", { status: 400 });
      }
    }
    const response = await deps.fetch(
      `${config.assistantRuntimeBaseUrl}${path}`,
      {
        method: bridge ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${deps.serviceToken()}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      },
    );
    if (bridge || !response.ok) {
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }
    const asset = (await response.json()) as {
      data: string;
      contentType: string;
    };
    return new Response(Buffer.from(asset.data, "base64"), {
      headers: {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store",
      },
    });
  };
}
