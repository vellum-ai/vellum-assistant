import { getLogger } from "../../util/logger.js";

const log = getLogger("embedding-billing-breaker");

/**
 * Lightweight circuit breaker for embedding billing blocks (HTTP 402).
 *
 * Unlike the Qdrant circuit breaker (which needs a failure threshold and
 * half-open probe logic), billing exhaustion is deterministic — a single
 * 402 means the org is depleted and every subsequent call will fail
 * identically. The breaker opens immediately on the first 402 and stays
 * open for COOLDOWN_MS, then allows one probe through. A successful
 * probe (no 402) closes the breaker; a failed probe re-opens it.
 */

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type BreakerState = "closed" | "open";

let breakerState: BreakerState = "closed";
let openedAt = 0;

export class EmbeddingBillingBlockError extends Error {
  constructor() {
    super("Embedding billing breaker open — org balance depleted");
    this.name = "EmbeddingBillingBlockError";
  }
}

/** Trip the breaker after a 402 billing block. */
export function recordBillingBlock(): void {
  if (breakerState === "closed") {
    log.warn(
      { cooldownMs: COOLDOWN_MS },
      "Embedding billing breaker opened — embedding jobs paused until probe succeeds",
    );
  }
  breakerState = "open";
  openedAt = Date.now();
}

/**
 * Clear the breaker after a successful embedding call during the probe
 * window. Ignored when the breaker is closed or when the cooldown has not
 * yet elapsed — this prevents a concurrent in-flight embed job (started
 * before the breaker opened) from prematurely closing a freshly-tripped
 * breaker.
 */
export function recordBillingSuccess(): void {
  if (breakerState !== "open") return;
  if (Date.now() - openedAt < COOLDOWN_MS) return;
  log.info("Embedding billing breaker closed — billing probe succeeded");
  breakerState = "closed";
  openedAt = 0;
}

/** True when the breaker is open and the cooldown has NOT yet elapsed. */
export function isEmbeddingBillingBreakerOpen(): boolean {
  if (breakerState === "closed") return false;
  if (Date.now() - openedAt >= COOLDOWN_MS) return false;
  return true;
}

/**
 * True when the breaker is open but the cooldown has elapsed, meaning the
 * next embed job should be allowed through as a probe to check whether
 * the org has been re-funded.
 */
export function shouldAllowBillingProbe(): boolean {
  return breakerState === "open" && Date.now() - openedAt >= COOLDOWN_MS;
}

/** Extract an HTTP status code from an error, if present. */
export function extractHttpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== "object") return undefined;

  // SDK-style errors (OpenAI, Anthropic) carry `.status` directly.
  if ("status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }

  // Gemini/Ollama backends embed the status in the message: "... (402): ..."
  if (err instanceof Error) {
    const match = err.message.match(/\((\d{3})\)/);
    if (match) return parseInt(match[1], 10);
  }

  return undefined;
}

/** @internal Test-only: reset breaker state. */
export function _resetEmbeddingBillingBreaker(): void {
  breakerState = "closed";
  openedAt = 0;
}
