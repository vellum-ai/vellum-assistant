/**
 * HTTP endpoints for CES credential metadata (identity + policy).
 *
 * - `GET    /v1/metadata`              : list records
 * - `POST   /v1/metadata/bulk`         : bulk set records
 * - `GET    /v1/metadata/:account`     : get one record
 * - `PUT    /v1/metadata/:account`     : set one record
 * - `DELETE /v1/metadata/:account`     : delete one record
 *
 * Auth: same `CES_SERVICE_TOKEN` bearer as secret CRUD.
 */

import { timingSafeEqual } from "node:crypto";

import { CredentialRecordSchema } from "@vellumai/service-contracts/credential-rpc";

import { getMetadataStore } from "../records/metadata-store.js";

const METADATA_PATH_PREFIX = "/v1/metadata";

function serviceToken(): string {
  return process.env["CES_SERVICE_TOKEN"] ?? "";
}

function checkAuth(req: Request): Response | null {
  const expectedToken = serviceToken();
  if (!expectedToken) {
    return new Response(JSON.stringify({ error: "Missing service token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") {
    return new Response(
      JSON.stringify({
        error: "Invalid Authorization header format. Expected: Bearer <token>",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const provided = Buffer.from(parts[1]!);
  const expected = Buffer.from(expectedToken);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return new Response(JSON.stringify({ error: "Invalid service token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleMetadataRoute(
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (!pathname.startsWith(METADATA_PATH_PREFIX)) {
    return null;
  }

  const authError = checkAuth(req);
  if (authError) {
    return authError;
  }

  const recordStore = getMetadataStore();
  const rest = pathname.slice(METADATA_PATH_PREFIX.length);

  if ((rest === "" || rest === "/") && req.method === "GET") {
    return json({ records: recordStore.list() });
  }

  if (rest === "/bulk" && req.method === "POST") {
    let body: { records?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!Array.isArray(body.records)) {
      return json({ error: "Body must contain a 'records' array field" }, 400);
    }
    const results: Array<{ account: string; ok: boolean }> = [];
    for (const entry of body.records) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { account?: unknown }).account !== "string"
      ) {
        return json(
          { error: "Each record entry must have a string 'account' field" },
          400,
        );
      }
      const parsed = CredentialRecordSchema.safeParse(
        (entry as { record?: unknown }).record,
      );
      if (!parsed.success) {
        return json(
          { error: "Each record entry must have a valid record" },
          400,
        );
      }
      const account = (entry as { account: string }).account;
      const ok = recordStore.setByAccount(account, parsed.data);
      results.push({ account, ok });
    }
    return json({ results });
  }

  if (!rest.startsWith("/")) {
    return null;
  }

  const rawAccount = decodeURIComponent(rest.slice(1));
  if (!rawAccount) {
    return json({ error: "Account name is required" }, 400);
  }

  switch (req.method) {
    case "GET": {
      const record = recordStore.getByAccount(rawAccount);
      if (!record) {
        return json(
          { error: "Credential metadata not found", account: rawAccount },
          404,
        );
      }
      return json({ account: rawAccount, record });
    }
    case "PUT": {
      let body: { record?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const parsed = CredentialRecordSchema.safeParse(body.record);
      if (!parsed.success) {
        return json({ error: "Body must contain a valid 'record'" }, 400);
      }
      const ok = recordStore.setByAccount(rawAccount, parsed.data);
      if (!ok) {
        return json(
          {
            error:
              "Failed to set credential metadata (account must match record service/field)",
            account: rawAccount,
          },
          400,
        );
      }
      return json({ ok: true, account: rawAccount });
    }
    case "DELETE": {
      const result = recordStore.deleteByAccount(rawAccount);
      if (result === "not-found") {
        return json(
          { error: "Credential metadata not found", account: rawAccount },
          404,
        );
      }
      if (result === "error") {
        return json(
          { error: "Failed to delete credential metadata", account: rawAccount },
          400,
        );
      }
      return json({ ok: true, account: rawAccount });
    }
    default:
      return json({ error: "Method not allowed" }, 405);
  }
}
