/**
 * Plugin lifecycle IPC routes.
 *
 * `POST /v1/plugins/register-installed` — fired by `assistant plugins install`
 * after the install CLI has written files to `<workspaceDir>/plugins/<name>/`.
 * The route asks the running daemon to live-register the plugin (build the
 * Plugin object, register past the closed-registration latch, run init(),
 * wire in tool/route/skill contributions) without requiring a restart.
 *
 * The route always returns 200 with a discriminated `status` describing the
 * outcome — the CLI branches on that status to surface one of three messages:
 *
 *   - "Plugin loaded — tools available now."   (status: "loaded" | "gated")
 *   - "Plugin installed. Start the assistant to load it." (status: "not-bootstrapped" | "feature-disabled")
 *   - "Plugin installed (load failed: <err>). Restart the assistant to retry."
 *     (status: "build-failed" | "init-failed" | "already-registered")
 *
 * Using 200 + status (instead of HTTP error codes) keeps the CLI's parse
 * shape simple: every outcome lands in the same `{ status, ... }` object.
 * The IPC adapter doesn't need to map status codes to retry semantics, and
 * the CLI gets a precise reason without parsing free-form error strings.
 *
 * Daemon-internal route — not exposed to guardians or the public surface.
 * Trust boundary is the IPC socket itself (only local CLI invocations can
 * reach it). Defense-in-depth: the daemon also re-checks the
 * `external-plugins` feature flag before honouring the call.
 */

import { z } from "zod";

import { getConfig } from "../../config/loader.js";
import type { DaemonContext } from "../../daemon/external-plugins-bootstrap.js";
import { installPluginPostBoot } from "../../daemon/external-plugins-bootstrap.js";
import { APP_VERSION } from "../../version.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const registerInstalledPluginRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "plugin name must be kebab-case (lowercase letters, digits, and single hyphens)",
    )
    .describe(
      "Name of the plugin to live-register. Must match the directory under <workspaceDir>/plugins/ written by `assistant plugins install`.",
    ),
});

const registerInstalledPluginResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("loaded"), name: z.string() }),
  z.object({
    status: z.literal("gated"),
    name: z.string(),
    flag: z.string().optional(),
  }),
  z.object({ status: z.literal("already-registered"), name: z.string() }),
  z.object({ status: z.literal("feature-disabled") }),
  z.object({ status: z.literal("not-bootstrapped") }),
  z.object({ status: z.literal("not-found"), pluginDir: z.string() }),
  z.object({ status: z.literal("build-failed"), error: z.string() }),
  z.object({
    status: z.literal("init-failed"),
    name: z.string(),
    error: z.string(),
  }),
]);

async function handleRegisterInstalledPlugin(args: RouteHandlerArgs) {
  const body = registerInstalledPluginRequestSchema.parse(args.body ?? {});
  const ctx: DaemonContext = {
    config: getConfig(),
    assistantVersion: APP_VERSION,
  };
  return installPluginPostBoot(body.name, ctx);
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "registerInstalledPlugin",
    endpoint: "plugins/register-installed",
    method: "POST",
    summary: "Register a newly-installed plugin into the running daemon",
    description:
      "Build, register, and initialize a plugin that `assistant plugins install` just wrote to disk, so the user does not need to restart the daemon to start using it.",
    tags: ["plugins"],
    handler: handleRegisterInstalledPlugin,
    requestBody: registerInstalledPluginRequestSchema,
    responseBody: registerInstalledPluginResponseSchema,
  },
];
