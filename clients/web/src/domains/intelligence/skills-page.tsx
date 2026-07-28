import { Navigate, useSearchParams } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Legacy `/assistant/skills` list URL. The list now lives on the merged
 * My Superpowers page — redirect there, preserving the query params
 * (`?q=` / `?filter=` / `?category=` carry the same meaning). The
 * `?skill=<id>` deep-link form resolves to the dedicated detail route so
 * existing bookmarks keep working.
 */
export function SkillsPage() {
  const [searchParams] = useSearchParams();

  const skillId = searchParams.get("skill");
  if (skillId) {
    return <Navigate to={routes.skills.detail(skillId)} replace />;
  }

  const search = searchParams.toString();
  return (
    <Navigate
      to={`${routes.superpowers}${search ? `?${search}` : ""}`}
      replace
    />
  );
}
