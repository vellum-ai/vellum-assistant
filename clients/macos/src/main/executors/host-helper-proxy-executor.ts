/**
 * Shared base for host-proxy executors that forward a single request to the
 * native mac-helper via one JSON-RPC method and post the parsed result back.
 *
 * Both the computer-use (`cu.perform`) and app-control (`appControl.perform`)
 * executors are the same shape — validate the request, call the helper, parse
 * the result, post it — differing only in the method name, the params they
 * build, the result schema, and which `poster.post*Result` they call. This
 * base captures the common flow, including the cancellation bookkeeping
 * (TTL-evicted so a cancel that races a completed request never leaks).
 */

import type { z } from "zod";

import type { HostProxyExecutor } from "../host-proxy-router";
import type { HostProxySseMessage } from "../host-proxy-sse";
import type { HostProxyPoster } from "../host-proxy-poster";
import type { MacHelperClient } from "../sidecar/mac-helper";
import log from "../logger";

/** Subset of the mac-helper client the executors depend on (injectable for tests). */
export type CuHelperClient = Pick<MacHelperClient, "call">;

const CANCEL_TTL_MS = 30_000;

/** Result of building helper params: the params, or a reason to reject up front. */
export type BuildParamsResult =
  | { params: Record<string, unknown> }
  | { error: string };

export interface HostHelperProxyConfig<T> {
  /** Short label for logs, e.g. "host-cu". */
  label: string;
  /** JSON-RPC method on the helper, e.g. "cu.perform". */
  method: string;
  resolveHelper: () => CuHelperClient;
  /** Schema the helper result is validated against (tolerant of extra keys). */
  schema: z.ZodType<T>;
  /**
   * Build the JSON-RPC params from the request, or return `{ error }` to reject
   * the request up front (posted via `postError`) without calling the helper.
   */
  buildParams: (message: HostProxySseMessage, requestId: string) => BuildParamsResult;
  /** Post a successful, validated result. */
  postSuccess: (poster: HostProxyPoster, requestId: string, result: T) => void;
  /** Post an error result (bad request, helper failure, invalid result). */
  postError: (poster: HostProxyPoster, requestId: string, message: string) => void;
}

export class HostHelperProxyExecutor<T> implements HostProxyExecutor {
  // Requests the daemon cancelled — their late helper result is dropped.
  // Timestamped so entries from cancels that arrive after completion expire.
  private readonly cancelledIds = new Map<string, number>();

  constructor(private readonly config: HostHelperProxyConfig<T>) {}

  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (!requestId) {
      log.warn(`[${this.config.label}] message missing requestId`);
      return;
    }

    if (this.consumeCancelled(requestId)) return;

    const built = this.config.buildParams(message, requestId);
    if ("error" in built) {
      this.config.postError(poster, requestId, built.error);
      return;
    }

    void this.run(requestId, built.params, poster);
  }

  handleCancel(message: HostProxySseMessage, _poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (requestId) this.markCancelled(requestId);
  }

  private async run(
    requestId: string,
    params: Record<string, unknown>,
    poster: HostProxyPoster,
  ): Promise<void> {
    try {
      const raw = await this.config.resolveHelper().call(this.config.method, params);
      if (this.consumeCancelled(requestId)) return;

      const parsed = this.config.schema.safeParse(raw);
      if (!parsed.success) {
        this.config.postError(
          poster,
          requestId,
          `mac helper returned invalid ${this.config.method} result`,
        );
        return;
      }

      this.config.postSuccess(poster, requestId, parsed.data);
    } catch (err) {
      if (this.consumeCancelled(requestId)) return;
      this.config.postError(
        poster,
        requestId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private markCancelled(requestId: string): void {
    const now = Date.now();
    this.cancelledIds.set(requestId, now);
    for (const [id, ts] of this.cancelledIds) {
      if (now - ts >= CANCEL_TTL_MS) this.cancelledIds.delete(id);
    }
  }

  /** Returns true (and clears the flag) when `requestId` was cancelled. */
  private consumeCancelled(requestId: string): boolean {
    return this.cancelledIds.delete(requestId);
  }
}
