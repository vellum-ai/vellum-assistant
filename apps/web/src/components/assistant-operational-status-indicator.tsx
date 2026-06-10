import { Tooltip, cn } from "@vellumai/design-library";

import {
  isHealthyOperationalStatus,
  type AssistantOperationalState,
  useAssistantOperationalStatus,
} from "@/assistant/operational-status";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

type IndicatorTone = "info" | "warning" | "danger" | "muted";

const STATE_LABELS: Record<AssistantOperationalState, string> = {
  initializing: "Assistant is initializing",
  provisioning: "Assistant is provisioning",
  active: "Assistant is healthy",
  sleeping: "Assistant is sleeping",
  waking: "Assistant is waking",
  restarting: "Assistant is restarting",
  restoring_backup: "Assistant is restoring a backup",
  upgrading_assistant_version: "Assistant is upgrading",
  resizing_machine: "Assistant machine is resizing",
  resizing_storage: "Assistant storage is resizing",
  maintenance_mode: "Assistant is in maintenance mode",
  crash_loop: "Assistant is crash looping",
  unreachable: "Assistant is unreachable",
  not_found: "Assistant was not found",
  retiring: "Assistant is retiring",
};

const TRANSIENT_STATES = new Set<AssistantOperationalState>([
  "initializing",
  "provisioning",
  "waking",
  "restarting",
  "restoring_backup",
  "upgrading_assistant_version",
  "resizing_machine",
  "resizing_storage",
  "retiring",
]);

function statusTone(state: AssistantOperationalState): IndicatorTone {
  switch (state) {
    case "crash_loop":
    case "unreachable":
    case "not_found":
      return "danger";
    case "sleeping":
    case "maintenance_mode":
      return "muted";
    case "waking":
    case "restarting":
    case "restoring_backup":
    case "upgrading_assistant_version":
    case "resizing_machine":
    case "resizing_storage":
      return "warning";
    default:
      return "info";
  }
}

function dotClassName(tone: IndicatorTone): string {
  switch (tone) {
    case "danger":
      return "bg-[var(--system-negative-strong)] text-[var(--system-negative-strong)]";
    case "warning":
      return "bg-[var(--system-mid-strong)] text-[var(--system-mid-strong)]";
    case "muted":
      return "bg-[var(--content-tertiary)] text-[var(--content-tertiary)]";
    case "info":
      return "bg-[var(--system-info-strong)] text-[var(--system-info-strong)]";
  }
}

export function AssistantOperationalStatusIndicator() {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const operationalStatusAssistantId =
    useAssistantLifecycleStore.use.operationalStatusAssistantId();
  const assistantId = operationalStatusAssistantId ?? activeAssistantId;
  const statusQuery = useAssistantOperationalStatus(assistantId);
  const status = statusQuery.data ?? null;

  if (statusQuery.isError) {
    return (
      <StatusDot state="unreachable" label="Assistant status is unavailable" />
    );
  }

  if (!status || isHealthyOperationalStatus(status)) {
    return null;
  }

  return <StatusDot state={status.state} label={STATE_LABELS[status.state]} />;
}

function StatusDot({
  state,
  label,
}: {
  state: AssistantOperationalState;
  label: string;
}) {
  const tone = statusTone(state);
  const pulse = TRANSIENT_STATES.has(state);

  return (
    <Tooltip content={label}>
      <span
        role="status"
        aria-label={label}
        data-testid="assistant-operational-status-indicator"
        data-state={state}
        className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        tabIndex={0}
      >
        <span
          aria-hidden="true"
          className={cn(
            "h-[50px] w-[50px] rounded-full shadow-[0_0_0_6px_color-mix(in_srgb,currentColor_16%,transparent)]",
            dotClassName(tone),
            pulse && "animate-pulse",
          )}
        />
      </span>
    </Tooltip>
  );
}
