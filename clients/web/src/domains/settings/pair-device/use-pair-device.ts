import { useCallback, useEffect, useRef, useState } from "react";

import { captureError } from "@/lib/sentry/capture-error";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";

import {
  mintDevicePairing,
  PairDeviceError,
  WEB_REMOTE_INGRESS_HINT,
  type DevicePairing,
} from "./pair-device-client";
import {
  publicBaseUrlRejectionMessage,
  resolvePublicBaseUrl,
} from "./pair-device-url";

/** localStorage key for the last public URL that successfully minted a code. */
const PUBLIC_BASE_URL_STORAGE_KEY = "vellum:pair-device:public-base-url";

/** Where the URL field's initial value came from. */
export type PairDevicePrefillSource = "tunnel" | "stored" | "none";

/**
 * Resolve the URL field's initial value and its provenance. Priority: the
 * assistant's `vellum tunnel`-recorded ingress URL, then the last URL that
 * successfully minted a code, then empty.
 */
function resolvePrefill(recordedIngressUrl: string | null): {
  url: string;
  source: PairDevicePrefillSource;
} {
  const tunnel = recordedIngressUrl?.trim();
  if (tunnel) {
    return { url: tunnel, source: "tunnel" };
  }
  const stored = getLocalSetting(PUBLIC_BASE_URL_STORAGE_KEY, "").trim();
  if (stored) {
    return { url: stored, source: "stored" };
  }
  return { url: "", source: "none" };
}

export type PairDevicePhase =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "ready"; pairUrl: string; expiresAtMs: number }
  | { kind: "error"; message: string; hint?: string };

export interface PairDeviceController {
  /** The public URL to advertise, editable and prefilled from the tunnel/last success. */
  publicBaseUrl: string;
  setPublicBaseUrl: (value: string) => void;
  /** Where {@link publicBaseUrl}'s initial value came from. */
  prefillSource: PairDevicePrefillSource;
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
 * `webRemoteIngressEnabled` is the host's `web-remote-ingress` flag — when off,
 * generating reports the enable guidance without minting (the loopback routes
 * succeed regardless of the flag, but a scan can only connect through public
 * ingress, so a minted QR would be unusable). `recordedIngressUrl` is the
 * assistant's `vellum tunnel`-recorded public URL, used to prefill the field.
 */
export function usePairDevice(
  base: string | null,
  webRemoteIngressEnabled: boolean,
  recordedIngressUrl: string | null,
): PairDeviceController {
  const [prefill] = useState(() => resolvePrefill(recordedIngressUrl));
  const [publicBaseUrl, setPublicBaseUrlState] = useState(prefill.url);
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
    const trimmed = publicBaseUrl.trim();
    const resolved = resolvePublicBaseUrl(trimmed);
    if (!resolved.ok) {
      setInputError(publicBaseUrlRejectionMessage(resolved.reason, trimmed));
      return;
    }
    setInputError(null);

    if (!webRemoteIngressEnabled) {
      setPhase({
        kind: "error",
        message:
          "Remote web access is disabled on this assistant, so a scanned code couldn't connect.",
        hint: WEB_REMOTE_INGRESS_HINT,
      });
      return;
    }

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
  }, [base, publicBaseUrl, webRemoteIngressEnabled]);

  const remainingMs =
    phase.kind === "ready" ? Math.max(0, phase.expiresAtMs - nowMs) : 0;
  const expired = phase.kind === "ready" && remainingMs <= 0;

  return {
    publicBaseUrl,
    setPublicBaseUrl,
    prefillSource: prefill.source,
    inputError,
    phase,
    remainingMs,
    expired,
    generate,
  };
}
