import { z } from "zod";

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
 * deps (CES client, provider credential refresh). The daemon registers
 * these at startup via `cliIpc.registerMethod(...)`.
 *
 * These routes delegate to the same `handleAddSecret` / `handleDeleteSecret`
 * / `handleReadSecret` handlers that the HTTP `/v1/secrets` endpoints use,
 * converting the Response objects into IPC-friendly JSON payloads.
 */
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
            (body.error as string) || `Secret write failed (${res.status})`,
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
            (body.error as string) || `Secret delete failed (${res.status})`,
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
            (body.error as string) || `Secret read failed (${res.status})`,
          );
        }
        return body;
      },
    },
  ];
}
