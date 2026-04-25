import { z } from "zod";

import type { HttpErrorResponse } from "../../runtime/http-errors.js";
import type { SecretRouteDeps } from "../../runtime/routes/secret-routes.js";
import {
  handleAddSecret,
  handleDeleteSecret,
  handleReadSecret,
} from "../../runtime/routes/secret-routes.js";
import type { IpcRoute } from "../assistant-server.js";

const SecretWriteParams = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  value: z.string().min(1),
});

const SecretDeleteParams = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
});

const SecretReadParams = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  reveal: z.boolean().optional(),
});

/**
 * Factory: returns secrets IPC routes that capture the daemon-owned
 * deps (CES client, provider credential refresh).
 */
function extractErrorMessage(
  body: Record<string, unknown>,
  fallback: string,
): string {
  const err = body.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return (err as HttpErrorResponse["error"]).message;
  }
  return fallback;
}

export function makeSecretsRoutes(deps: SecretRouteDeps): IpcRoute[] {
  return [
    {
      method: "secrets/write",
      handler: async (params) => {
        const { type, name, value } = SecretWriteParams.parse(params);
        const fakeReq = new Request("http://localhost/v1/secrets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, name, value }),
        });
        const res = await handleAddSecret(fakeReq, deps);
        const body = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            extractErrorMessage(body, `Secret write failed (${res.status})`),
          );
        }
        return body;
      },
    },
    {
      method: "secrets/delete",
      handler: async (params) => {
        const { type, name } = SecretDeleteParams.parse(params);
        const fakeReq = new Request("http://localhost/v1/secrets", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, name }),
        });
        const res = await handleDeleteSecret(fakeReq, deps);
        const body = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            extractErrorMessage(body, `Secret delete failed (${res.status})`),
          );
        }
        return body;
      },
    },
    {
      method: "secrets/read",
      handler: async (params) => {
        const { type, name, reveal } = SecretReadParams.parse(params);
        const fakeReq = new Request("http://localhost/v1/secrets/read", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, name, reveal }),
        });
        const res = await handleReadSecret(fakeReq);
        const body = (await res.json()) as Record<string, unknown>;
        if (!res.ok) {
          throw new Error(
            extractErrorMessage(body, `Secret read failed (${res.status})`),
          );
        }
        return body;
      },
    },
  ];
}
