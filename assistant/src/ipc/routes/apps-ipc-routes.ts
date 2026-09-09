/**
 * IPC-only app compile/refresh method used by `assistant apps refresh`.
 *
 * Compile must run inside the assistant process so open surfaces, client
 * broadcasts, and published-app redeploy see the new dist. The CLI process
 * has an empty conversation registry, so an in-process compile there would
 * leave live surfaces stale.
 *
 * No HTTP surface: this is a CLI compile trigger, not a client API. Plugin
 * apps are refused; their dist/ is owned by the plugin source watcher.
 */

import { z } from "zod";

import { getApp, getAppDirPath, isPluginAppId } from "../../apps/app-store.js";
import { compileApp } from "../../bundler/app-compiler.js";
import { notifyAppSurfacesChanged } from "../../daemon/app-change-notify.js";
import {
  BadRequestError,
  NotFoundError,
} from "../../runtime/routes/errors.js";
import type { RouteHandlerArgs } from "../../runtime/routes/types.js";

const AppsRefreshParamsSchema = z.object({
  appId: z.string().min(1),
});

export async function handleAppsRefresh({ body = {} }: RouteHandlerArgs) {
  const { appId } = AppsRefreshParamsSchema.parse(body);

  if (isPluginAppId(appId)) {
    throw new BadRequestError(
      "Plugin-bundled apps are compiled by their plugin, not by this command. Run 'assistant apps list' to see workspace apps.",
    );
  }

  const app = getApp(appId);
  if (!app) {
    throw new NotFoundError(
      `App "${appId}" not found. Run 'assistant apps list' to see available apps.`,
    );
  }

  const compileResult = await compileApp(getAppDirPath(appId));
  notifyAppSurfacesChanged(appId, { fileChange: true });

  return {
    ok: true as const,
    appId: app.id,
    name: app.name,
    compiled: compileResult.ok,
    compile_duration_ms: compileResult.durationMs,
    ...(compileResult.ok
      ? {}
      : {
          compile_errors: compileResult.errors,
          compile_warnings: compileResult.warnings,
        }),
  };
}

export const APPS_IPC_METHODS: Record<
  string,
  (args: RouteHandlerArgs) => unknown
> = {
  apps_refresh: handleAppsRefresh,
};
