import type { Surface } from "@/domains/chat/types/types";

function normalizeAppId(rawAppId: unknown): string | null {
  if (typeof rawAppId !== "string") return null;

  const appId = rawAppId.trim();
  return appId.length > 0 ? appId : null;
}

export function getDynamicPageAppId(surface: Pick<Surface, "data">): string | null {
  return normalizeAppId(surface.data.appId) ?? normalizeAppId(surface.data.app_id);
}
