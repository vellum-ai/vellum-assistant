import { getLogger } from "../../../util/logger.js";
import { browserManager } from "../browser-manager.js";
import { CdpError } from "./errors.js";
import type { CdpClientKind, ScopedCdpClient } from "./types.js";

const log = getLogger("local-cdp-client");

/**
 * Minimal shape of the Playwright CDPSession we depend on. Avoids a
 * direct Playwright type import so the CDP client stays buildable
 * even when Playwright types are not present (dev builds, CI jobs
 * that skip the playwright install).
 */
interface PlaywrightCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

/**
 * Minimal shape of the Playwright Page we use for CDP session
 * creation. Intentionally narrow so we never have to import the
 * Playwright types directly from this module.
 */
interface RawPlaywrightPage {
  context(): {
    newCDPSession(page: unknown): Promise<PlaywrightCdpSession>;
  };
}

/**
 * Playwright-backed implementation of {@link ScopedCdpClient}. Used
 * for CLI conversations, headless cloud conversations, unit tests,
 * and any desktop conversation that does not have a `hostBrowserProxy`
 * configured.
 *
 * LocalCdpClient owns only the per-conversation CDP session; the
 * underlying Chromium is still launched and torn down by
 * `browserManager.ensureContext()` / `browserManager.shutdown()`.
 */
export class LocalCdpClient implements ScopedCdpClient {
  readonly kind: CdpClientKind = "local";

  private sessionPromise: Promise<PlaywrightCdpSession> | null = null;
  private disposed = false;

  constructor(public readonly conversationId: string) {}

  /**
   * Lazily create (and cache) a Playwright CDP session for this
   * conversation. Concurrent callers share the same in-flight promise
   * so `newCDPSession` is only called once per LocalCdpClient
   * instance.
   *
   * If the underlying browser launch / `newCDPSession` rejects (e.g.
   * a transient Chromium spawn failure), the cached promise is
   * cleared so the next `ensureSession()` call retries from scratch
   * instead of replaying the same rejection forever.
   */
  private async ensureSession(): Promise<PlaywrightCdpSession> {
    if (this.disposed) {
      throw new CdpError("disposed", "LocalCdpClient already disposed");
    }
    if (this.sessionPromise) return this.sessionPromise;
    const created = this.createSession();
    this.sessionPromise = created;
    // Clear the cached promise on rejection so the next call retries
    // from scratch instead of replaying the same failure forever.
    // Only clear if `created` is still the cached promise — a
    // concurrent dispose may have already nulled it.
    created.catch(() => {
      if (this.sessionPromise === created) {
        this.sessionPromise = null;
      }
    });
    return created;
  }

  private async createSession(): Promise<PlaywrightCdpSession> {
    const page = await browserManager.getOrCreateSessionPage(
      this.conversationId,
    );
    const rawPage = page as unknown as RawPlaywrightPage;
    const session = await rawPage.context().newCDPSession(rawPage);
    log.debug(
      { conversationId: this.conversationId },
      "Created Playwright CDP session for LocalCdpClient",
    );
    return session;
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      throw new CdpError("disposed", "LocalCdpClient already disposed", {
        cdpMethod: method,
        cdpParams: params,
      });
    }
    if (signal?.aborted) {
      throw new CdpError("aborted", "Aborted before send", {
        cdpMethod: method,
        cdpParams: params,
      });
    }
    let session: PlaywrightCdpSession;
    try {
      session = await this.ensureSession();
    } catch (err) {
      if (signal?.aborted) {
        throw new CdpError("aborted", "Aborted during send", {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      // Re-throw existing CdpError instances unchanged so we don't
      // double-wrap (e.g. a "disposed" error raised by a concurrent
      // dispose landing during ensureSession()).
      if (err instanceof CdpError) {
        throw err;
      }
      // ensureSession failures (browser launch errors, Chromium
      // spawn failures, etc) are surfaced as transport_error so
      // callers can distinguish them from CDP protocol errors raised
      // by session.send below.
      const msg = err instanceof Error ? err.message : String(err);
      throw new CdpError("transport_error", msg, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
    }
    try {
      const result = (await session.send(method, params)) as T;
      return result;
    } catch (err) {
      if (signal?.aborted) {
        throw new CdpError("aborted", "Aborted during send", {
          cdpMethod: method,
          cdpParams: params,
          underlying: err,
        });
      }
      if (err instanceof CdpError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CdpError("cdp_error", msg, {
        cdpMethod: method,
        cdpParams: params,
        underlying: err,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.sessionPromise;
    this.sessionPromise = null;
    if (!pending) return;
    pending
      .then(async (session) => {
        try {
          await session.detach();
        } catch (err) {
          log.debug({ err }, "LocalCdpClient: session.detach threw (ignored)");
        }
      })
      .catch(() => {
        // Session never resolved — nothing to detach.
      });
  }
}

/**
 * Factory for a fresh {@link LocalCdpClient} bound to a conversation.
 * Keeping the constructor + factory split lets the cdp-client factory
 * (PR 6) branch between local and extension transports without
 * exposing the class directly to callers.
 */
export function createLocalCdpClient(conversationId: string): LocalCdpClient {
  return new LocalCdpClient(conversationId);
}
