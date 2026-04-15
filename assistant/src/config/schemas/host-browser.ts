import { z } from "zod";

/**
 * Configuration for the automatic cdp-inspect attempt on macOS. When a macOS
 * turn reaches the CDP factory and `desktopAuto.enabled` is true, the factory
 * includes cdp-inspect as a candidate even when the top-level `enabled` flag
 * is false. This lets macOS users benefit from direct Chrome attach without
 * requiring manual `hostBrowser.cdpInspect.enabled = true`.
 *
 * If the cdp-inspect probe fails (e.g. Chrome was not launched with
 * `--remote-debugging-port`), the factory records a cooldown timestamp and
 * skips the probe for subsequent calls until the cooldown expires. This bounds
 * the per-call latency penalty to `probeTimeoutMs` once per cooldown window.
 */
export const DesktopAutoCdpInspectConfigSchema = z
  .object({
    enabled: z
      .boolean({
        error: "hostBrowser.cdpInspect.desktopAuto.enabled must be a boolean",
      })
      .default(true)
      .describe(
        "Whether macOS turns automatically attempt cdp-inspect before falling back to the local Playwright backend. When true (default on macOS), the factory inserts a cdp-inspect candidate between the extension and local backends even when the top-level `cdpInspect.enabled` is false.",
      ),
    cooldownMs: z
      .number({
        error: "hostBrowser.cdpInspect.desktopAuto.cooldownMs must be a number",
      })
      .int("hostBrowser.cdpInspect.desktopAuto.cooldownMs must be an integer")
      .min(0, "hostBrowser.cdpInspect.desktopAuto.cooldownMs must be >= 0")
      .max(
        300_000,
        "hostBrowser.cdpInspect.desktopAuto.cooldownMs must be <= 300000",
      )
      .default(30_000)
      .describe(
        "Duration (in milliseconds) to suppress automatic cdp-inspect probes after a transport-level failure. While on cooldown the factory skips the cdp-inspect candidate and goes straight to the local backend. Set to 0 to disable cooldown (always probe).",
      ),
  })
  .describe("Auto-attempt policy for cdp-inspect on macOS-originated turns.");

export type DesktopAutoCdpInspectConfig = z.infer<
  typeof DesktopAutoCdpInspectConfigSchema
>;

/**
 * Configuration for the `cdp-inspect` browser backend — connects directly
 * to a host Chrome instance that was launched with `--remote-debugging-port`
 * (e.g. `chrome://inspect`-style remote debugging) as an alternative to the
 * extension or local Playwright backend.
 */
export const HostBrowserCdpInspectConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "hostBrowser.cdpInspect.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the cdp-inspect backend is enabled. When true, the factory will route browser tool calls through the configured host/port instead of the local Playwright backend.",
      ),
    host: z
      .string({ error: "hostBrowser.cdpInspect.host must be a string" })
      .transform((v) => v || "localhost")
      .default("localhost")
      .describe(
        "Host name or IP address where the host Chrome instance exposes its remote debugging endpoint.",
      ),
    port: z
      .number({ error: "hostBrowser.cdpInspect.port must be a number" })
      .int("hostBrowser.cdpInspect.port must be an integer")
      .min(1, "hostBrowser.cdpInspect.port must be >= 1")
      .max(65535, "hostBrowser.cdpInspect.port must be <= 65535")
      .default(9222)
      .describe(
        "TCP port for the host Chrome remote-debugging endpoint (matches `--remote-debugging-port`).",
      ),
    probeTimeoutMs: z
      .number({
        error: "hostBrowser.cdpInspect.probeTimeoutMs must be a number",
      })
      .int("hostBrowser.cdpInspect.probeTimeoutMs must be an integer")
      .min(50, "hostBrowser.cdpInspect.probeTimeoutMs must be >= 50")
      .max(5000, "hostBrowser.cdpInspect.probeTimeoutMs must be <= 5000")
      .default(500)
      .describe(
        "Timeout (in milliseconds) for the backend availability probe. Kept small so browser tool calls fail fast when the endpoint is unreachable.",
      ),
    desktopAuto: DesktopAutoCdpInspectConfigSchema.default(
      DesktopAutoCdpInspectConfigSchema.parse({}),
    ),
  })
  .describe(
    "Settings for the cdp-inspect backend that connects to a host Chrome instance via its remote-debugging endpoint.",
  );

export type HostBrowserCdpInspectConfig = z.infer<
  typeof HostBrowserCdpInspectConfigSchema
>;

/**
 * Top-level configuration for host-browser backends. Currently only exposes
 * `cdpInspect`, but the shape leaves room for additional host-browser knobs
 * (e.g. extension-specific settings) without another namespace churn.
 */
export const HostBrowserConfigSchema = z
  .object({
    cdpInspect: HostBrowserCdpInspectConfigSchema.default(
      HostBrowserCdpInspectConfigSchema.parse({}),
    ),
  })
  .describe("Host-browser backend configuration (cdp-inspect, etc.)");

export type HostBrowserConfig = z.infer<typeof HostBrowserConfigSchema>;
