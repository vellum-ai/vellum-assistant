/**
 * Tests for the `Request` the `/x/*` routes synthesize for user-authored
 * handler files.
 *
 * Three properties matter here. Fidelity: served over HTTP the handler sees the
 * pathname and query the client sent, so repeated query keys and
 * percent-encoded path segments survive; served over IPC there is no wire URL,
 * so both are rebuilt from the matched path and the flattened query. Stability:
 * the origin is synthetic on every transport, so a handler resolving a relative
 * URL against `request.url` reads the same host everywhere. And audience: the
 * verified
 * `x-vellum-subject` is daemon-side authorization material and stays out of
 * workspace code, while the identity the handler has always seen, and every
 * other header, still reaches it.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getWorkspaceRoutesDir } from "../../../util/platform.js";
import type { RouteHandlerArgs, RouteResponse } from "../types.js";
import { ROUTES } from "../user-routes.js";

/** A path whose single segment is percent-encoded on the wire. */
const ROUTE_PATH = "hello world";

const ECHO_HANDLER = `export function GET(request) {
  const url = new URL(request.url);
  return Response.json({
    origin: url.origin,
    pathname: url.pathname,
    tags: url.searchParams.getAll("tag"),
    subject: request.headers.get("x-vellum-subject"),
    principalType: request.headers.get("x-vellum-principal-type"),
    actorPrincipalId: request.headers.get("x-vellum-actor-principal-id"),
    clientId: request.headers.get("x-vellum-client-id"),
  });
}
`;

interface EchoBody {
  origin: string;
  pathname: string;
  tags: string[];
  subject: string | null;
  principalType: string | null;
  actorPrincipalId: string | null;
  clientId: string | null;
}

const getHandler = ROUTES.find((r) => r.operationId === "user_route_get")!
  .handler as (args: RouteHandlerArgs) => Promise<RouteResponse>;

const IDENTITY_HEADERS_IN: Record<string, string> = {
  "x-vellum-principal-type": "actor",
  "x-vellum-actor-principal-id": "user-123",
  "x-vellum-subject": "actor:self:user-123",
  "x-vellum-client-id": "client-abc",
};

async function echo(args: RouteHandlerArgs): Promise<EchoBody> {
  const response = await getHandler(args);
  expect(response.status).toBe(200);
  return (await new Response(response.body).json()) as EchoBody;
}

beforeEach(() => {
  mkdirSync(getWorkspaceRoutesDir(), { recursive: true });
  writeFileSync(
    join(getWorkspaceRoutesDir(), `${ROUTE_PATH}.ts`),
    ECHO_HANDLER,
  );
});

afterEach(() => {
  rmSync(getWorkspaceRoutesDir(), { recursive: true, force: true });
});

describe("user route request URL", () => {
  test("served over HTTP, the wire path and query reach the handler intact", async () => {
    const body = await echo({
      pathParams: { path: ROUTE_PATH },
      // The flattened record the adapter also passes: last value wins, so it
      // cannot be the source of the repeated keys.
      queryParams: { tag: "b" },
      rawUrl: new URL("http://127.0.0.1:4747/v1/x/hello%20world?tag=a&tag=b"),
      headers: IDENTITY_HEADERS_IN,
    });

    expect(body.pathname).toBe("/v1/x/hello%20world");
    expect(body.tags).toEqual(["a", "b"]);
  });

  test("served over IPC, the URL is rebuilt from the matched path and query", async () => {
    const body = await echo({
      pathParams: { path: ROUTE_PATH },
      queryParams: { tag: "b" },
      headers: IDENTITY_HEADERS_IN,
    });

    expect(body.pathname).toBe("/v1/x/hello%20world");
    expect(body.tags).toEqual(["b"]);
  });

  test("a forged rawUrl falls back to the rebuilt URL", async () => {
    // An IPC caller controls every handler arg, and
    // `new URL("//host/x", "http://localhost")` resolves to `http://host/x`,
    // so a plain object claiming a two-slash pathname would defeat the origin
    // this code exists to pin. Only a real URL is trusted.
    const body = await echo({
      pathParams: { path: ROUTE_PATH },
      queryParams: { tag: "b" },
      rawUrl: {
        pathname: "//evil.example.com/v1/x/hello%20world",
        search: "?tag=a",
      } as unknown as URL,
      headers: IDENTITY_HEADERS_IN,
    });

    expect(body.origin).toBe("http://localhost");
    expect(body.pathname).toBe("/v1/x/hello%20world");
    expect(body.tags).toEqual(["b"]);
  });

  test("the origin is the same synthetic host on both transports", async () => {
    const overHttp = await echo({
      pathParams: { path: ROUTE_PATH },
      rawUrl: new URL("http://127.0.0.1:4747/v1/x/hello%20world?tag=a&tag=b"),
      headers: IDENTITY_HEADERS_IN,
    });
    const overIpc = await echo({
      pathParams: { path: ROUTE_PATH },
      headers: IDENTITY_HEADERS_IN,
    });

    expect(overHttp.origin).toBe("http://localhost");
    expect(overIpc.origin).toBe("http://localhost");
  });
});

describe("user route identity headers", () => {
  test("the verified subject does not reach a user-authored handler", async () => {
    const body = await echo({
      pathParams: { path: ROUTE_PATH },
      rawUrl: new URL("http://127.0.0.1:4747/v1/x/hello%20world"),
      headers: IDENTITY_HEADERS_IN,
    });

    expect(body.subject).toBeNull();
  });

  test("the caller's principal type, actor id, and other headers still do", async () => {
    const body = await echo({
      pathParams: { path: ROUTE_PATH },
      headers: IDENTITY_HEADERS_IN,
    });

    expect(body.principalType).toBe("actor");
    expect(body.actorPrincipalId).toBe("user-123");
    expect(body.clientId).toBe("client-abc");
  });
});
