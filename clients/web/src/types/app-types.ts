import type {
  AppsByIdOpenPostResponse,
  AppsGetResponse,
} from "@/generated/daemon/types.gen";

export type AppSummary = AppsGetResponse["apps"][number];

export type AppOpenResponse = AppsByIdOpenPostResponse;

/**
 * Whether an app is read-only over the daemon's mutation surface. The daemon
 * tags each app's provenance in `origin`: `"workspace"` for user-created apps,
 * or `"plugin:<name>"` for apps bundled by an installed plugin. Plugin apps are
 * owned by their plugin — the daemon rejects delete / share / deploy / preview
 * mutations against them — so the Library hides those actions rather than
 * offer buttons that error server-side. Anything not workspace-owned is
 * read-only; an absent origin (older cached response) is treated as writable so
 * existing workspace apps are never accidentally locked down.
 */
export function isReadOnlyApp(origin: string | undefined): boolean {
  return origin != null && origin !== "workspace";
}
