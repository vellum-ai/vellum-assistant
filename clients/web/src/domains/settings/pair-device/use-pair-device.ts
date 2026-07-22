import { useCallback, useEffect, useRef, useState } from "react";

import { captureError } from "@/lib/sentry/capture-error";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

import {
  mintDevicePairing,
  PairDeviceError,
  type DevicePairing,
} from "./pair-device-client";
import {
  publicBaseUrlRejectionMessage,
  resolvePublicBaseUrl,
} from "./pair-device-url";

/** localStorage key for the last public URL that successfully minted a code. */
const PUBLIC_BASE_URL_STORAGE_KEY = "vellum:pair-device:public-base-url";

export type PairDevicePhase =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "ready"; pairUrl: string; expiresAtMs: number }
  | { kind: "error"; message: string; hint?: string };

export interface PairDeviceController {
  /** The public URL to advertise, editable and prefilled from the last success. */
  publicBaseUrl: string;
  setPublicBaseUrl: (value: string) => void;
  /** Client-side validation message for the URL field, or `null`. */
  inputError: string | null;
  phase: PairDevicePhase;
  /** Milliseconds until the live code expires (0 outside the `ready` phase). */
  remainingMs: number;
  /** Whether a live code has passed its expiry. */
  expired: boolean;
  /** Validate the URL and mint a code (also used to regenerate). */
  generate: () => void;
}

/**
 * Drives the "Pair a device" flow: URL validation + prefill, the mint/approve
 * request against the host's loopback gateway, and a 1s expiry countdown while a
 * code is live. `base` is the resolved local-gateway base URL, or `null` when
 * pairing isn't available from here (the hook then no-ops).
 */
export function usePairDevice(base: string | null): PairDeviceController {
  const [publicBaseUrl, setPublicBaseUrlState] = useState(() =>
    getLocalSetting(PUBLIC_BASE_URL_STORAGE_KEY, ""),
  );
  const [inputError, setInputError] = useState<string | null>(null);
  const [phase, setPhase] = useState<PairDevicePhase>({ kind: "idle" });
  const [nowMs, setNowMs] = useState(() => Date.now());

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Run a 1s clock only while a code is live so the countdown advances and the
  // UI flips to "expired" on its own — no background timer the rest of the time.
  useEffect(() => {
    if (phase.kind !== "ready") {
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const setPublicBaseUrl = useCallback((value: string) => {
    setPublicBaseUrlState(value);
    setInputError(null);
  }, []);

  const generate = useCallback(() => {
    if (!base) {
      return;
    }
    const resolved = resolvePublicBaseUrl(publicBaseUrl.trim());
    if (!resolved.ok) {
      setInputError(publicBaseUrlRejectionMessage(resolved.reason));
      return;
    }
    setInputError(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase({ kind: "minting" });
    void (async () => {
      try {
        const pairing: DevicePairing = await mintDevicePairing({
          base,
          publicBaseUrl: resolved.url,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        // Remember the URL that worked so the next open prefills it.
        setLocalSetting(PUBLIC_BASE_URL_STORAGE_KEY, resolved.url);
        setPhase({
          kind: "ready",
          pairUrl: pairing.pairUrl,
          expiresAtMs: Date.parse(pairing.expiresAt),
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (err instanceof PairDeviceError) {
          setPhase({ kind: "error", message: err.message, hint: err.hint });
          return;
        }
        captureError(err, { context: "pair-device-mint" });
        setPhase({
          kind: "error",
          message: "Something went wrong while generating the code.",
        });
      }
    })();
  }, [base, publicBaseUrl]);

  const remainingMs =
    phase.kind === "ready" ? Math.max(0, phase.expiresAtMs - nowMs) : 0;
  const expired = phase.kind === "ready" && remainingMs <= 0;

  return {
    publicBaseUrl,
    setPublicBaseUrl,
    inputError,
    phase,
    remainingMs,
    expired,
    generate,
  };
}
