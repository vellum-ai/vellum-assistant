import { useQuery } from "@tanstack/react-query";
import { Check, Monitor } from "lucide-react";

import { setSelectedAssistant } from "@/assistant/selection";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { assistantsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { Assistant } from "@/generated/api/types.gen";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { toast } from "@vellumai/design-library/components/toast";

const PLATFORM_LIST_OPTIONS = assistantsListOptions({
  query: { hosting: "platform" },
});

export function AssistantPicker() {
  const activeAssistantId = useActiveAssistantId();
  const listQuery = useQuery(PLATFORM_LIST_OPTIONS);
  const platformAssistants = (listQuery.data?.results ?? []) as Assistant[];

  if (listQuery.isPending || platformAssistants.length < 2) {
    return null;
  }

  return (
    <DetailCard
      title="Switch Assistant"
      subtitle="Choose which assistant is active for this account."
    >
      <div className="space-y-2">
        {platformAssistants.map((a) => {
          const isActive = a.id === activeAssistantId;

          return (
            <div
              key={a.id}
              className={`flex items-center justify-between gap-4 rounded-lg border px-4 py-3 ${
                isActive
                  ? "border-[var(--border-focus)] bg-[var(--surface-lift)]"
                  : "border-[var(--border-base)] bg-[var(--surface-default)]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Monitor className="h-4 w-4 shrink-0 text-[var(--content-tertiary)]" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-body-medium-default text-[var(--content-default)]">
                      {a.name || "Unnamed"}
                    </span>
                    {a.status !== "active" && (
                      <Tag tone="warning">{a.status}</Tag>
                    )}
                  </div>
                </div>
              </div>

              <div className="shrink-0">
                {isActive ? (
                  <span className="flex items-center gap-1.5 text-body-small-default text-[var(--system-positive-default)]">
                    <Check className="h-4 w-4" />
                    Active
                  </span>
                ) : (
                  <Button
                    variant="outlined"
                    size="compact"
                    disabled={a.status !== "active"}
                    onClick={() => {
                      void setSelectedAssistant(a.id);
                      toast.success("Switched active assistant.");
                    }}
                  >
                    Switch
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </DetailCard>
  );
}
