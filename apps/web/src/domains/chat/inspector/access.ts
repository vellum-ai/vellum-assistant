import type { AuthUser } from "@/stores/auth-store.js";

export function canUseLlmInspector(user: AuthUser | null): boolean {
  return (
    user?.isStaff === true ||
    user?.email?.toLowerCase().endsWith("@vellum.ai") === true
  );
}
