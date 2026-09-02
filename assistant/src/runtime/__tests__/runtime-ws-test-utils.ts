/** Shared pieces for suites that open WebSockets against `RuntimeHttpServer`. */

import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";
import { mintToken } from "../auth/token-service.js";

export function mintGatewayToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "svc:gateway:self",
    scope_profile: "gateway_ingress_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

export function mintActorToken(): string {
  return mintToken({
    aud: "vellum-daemon",
    sub: "actor:self:user-123",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}

/** Headers of a WebSocket upgrade sent through plain `fetch`. */
export const upgradeHeaders = {
  Upgrade: "websocket",
  Connection: "Upgrade",
  "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  "Sec-WebSocket-Version": "13",
};

export function waitForClose(
  ws: WebSocket,
  timeoutMs = 2000,
): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket close"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    };
    const onClose = (event: CloseEvent) => {
      cleanup();
      resolve(event);
    };
    const onError = () => {
      cleanup();
      reject(new Error("WebSocket close failed"));
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
  });
}

/** Turn real HTTP auth on for a test; the returned function restores the env. */
export function requireHttpAuth(): () => void {
  const saved = process.env.DISABLE_HTTP_AUTH;
  delete process.env.DISABLE_HTTP_AUTH;
  return () => {
    if (saved === undefined) {
      delete process.env.DISABLE_HTTP_AUTH;
    } else {
      process.env.DISABLE_HTTP_AUTH = saved;
    }
  };
}
