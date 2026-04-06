/**
 * Gateway proxies for the daemon migration export/import endpoints.
 *
 * Follows the same forwarding pattern as upgrade-broadcast-proxy.ts:
 * strips hop-by-hop headers, replaces the client's edge JWT with a
 * minted service token, and proxies the request to the daemon.
 */

import { mintServiceToken } from "../../auth/token-exchange.js";
import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { stripHopByHop } from "../../util/strip-hop-by-hop.js";

const log = getLogger("migration-proxy");

/** Timeout for migration requests (120 seconds) — exports/imports can be large. */
const MIGRATION_TIMEOUT_MS = 120_000;

export function createMigrationExportProxyHandler(config: GatewayConfig) {
  return async function handleMigrationExport(req: Request): Promise<Response> {
    const start = performance.now();
    const bodyBuffer = await req.arrayBuffer();

    const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/export`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, MIGRATION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error({ duration }, "Migration export proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration },
        "Migration export proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration },
        "Migration export proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration },
      "Migration export proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}

export function createMigrationImportPreflightProxyHandler(
  config: GatewayConfig,
) {
  return async function handleMigrationImportPreflight(
    req: Request,
  ): Promise<Response> {
    const start = performance.now();
    const bodyBuffer = await req.arrayBuffer();

    const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/import-preflight`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, MIGRATION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error(
          { duration },
          "Migration import-preflight proxy upstream timed out",
        );
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration },
        "Migration import-preflight proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration },
        "Migration import-preflight proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration },
      "Migration import-preflight proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}

export function createMigrationImportProxyHandler(config: GatewayConfig) {
  return async function handleMigrationImport(req: Request): Promise<Response> {
    const start = performance.now();
    const bodyBuffer = await req.arrayBuffer();

    const upstream = `${config.assistantRuntimeBaseUrl}/v1/migrations/import`;

    const reqHeaders = stripHopByHop(new Headers(req.headers));
    reqHeaders.delete("host");
    reqHeaders.delete("authorization");

    reqHeaders.set("authorization", `Bearer ${mintServiceToken()}`);
    reqHeaders.set("content-length", String(bodyBuffer.byteLength));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(
        new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError",
        ),
      );
    }, MIGRATION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetchImpl(upstream, {
        method: "POST",
        headers: reqHeaders,
        body: bodyBuffer,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      const duration = Math.round(performance.now() - start);
      if (err instanceof DOMException && err.name === "TimeoutError") {
        log.error({ duration }, "Migration import proxy upstream timed out");
        return Response.json({ error: "Gateway Timeout" }, { status: 504 });
      }
      log.error(
        { err, duration },
        "Migration import proxy upstream connection failed",
      );
      return Response.json({ error: "Bad Gateway" }, { status: 502 });
    }

    const resHeaders = stripHopByHop(new Headers(response.headers));
    const duration = Math.round(performance.now() - start);

    if (response.status >= 400) {
      const body = await response.text();
      log.warn(
        { status: response.status, duration },
        "Migration import proxy upstream error",
      );
      return new Response(body, {
        status: response.status,
        headers: resHeaders,
      });
    }

    log.info(
      { status: response.status, duration },
      "Migration import proxy completed",
    );
    return new Response(response.body, {
      status: response.status,
      headers: resHeaders,
    });
  };
}
