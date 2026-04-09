import { z } from "zod";

/**
 * Configuration for the `cdp-inspect` browser backend — connects directly
 * to a host Chrome instance that was launched with `--remote-debugging-port`
 * (e.g. `chrome://inspect`-style remote debugging). Serves as a fallback
 * between the extension backend (user's Chrome via chrome.debugger) and the
 * local Playwright-backed backend.
 */
export const HostBrowserCdpInspectConfigSchema = z
  .object({
    enabled: z
      .boolean({ error: "hostBrowser.cdpInspect.enabled must be a boolean" })
      .default(false)
      .describe(
        "Whether the cdp-inspect backend is enabled. When true, the browser-session manager will probe the configured host/port before falling back to the local Playwright backend.",
      ),
    host: z
      .string({ error: "hostBrowser.cdpInspect.host must be a string" })
      .min(1, "hostBrowser.cdpInspect.host must not be empty")
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
        "Timeout (in milliseconds) for the backend availability probe. Kept small so the fallback to the local backend stays snappy.",
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
