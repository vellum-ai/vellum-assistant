import { Loader2 } from "lucide-react";

/** Centered spinner shown while a Skills surface query is in flight. */
export function SkillsLoadingState() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2
        className="h-6 w-6 animate-spin"
        style={{ color: "var(--content-tertiary)" }}
      />
    </div>
  );
}
