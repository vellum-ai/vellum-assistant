import { useNavigate } from "react-router";

import { SystemTasksSection } from "@/domains/settings/components/system-tasks-section";
import { useSystemTasks } from "@/domains/settings/hooks/use-system-tasks";
import { SYSTEM_TASK_URL_IDS } from "@/domains/settings/utils/schedule-formatters";
import { routes } from "@/utils/routes";
import { useEffectiveTimezone } from "@/utils/use-effective-timezone";

/**
 * Top-level wrapper so the `logs` Usage tab can surface the system-schedules
 * accordion (heartbeat / consolidation / memory retrospective) without
 * importing `@/domains/settings/...` directly — the cross-domain lint rule
 * forbids `logs` → `settings`, so the shared composition lives here. The
 * system tasks own their detail views under the settings schedules route, so
 * rows navigate there.
 */
export function SystemSchedulesUsageSection({
  assistantId,
}: {
  assistantId: string;
}) {
  const navigate = useNavigate();
  const tz = useEffectiveTimezone();
  const systemTasks = useSystemTasks(assistantId, tz);

  return (
    <SystemTasksSection
      heartbeatConfig={systemTasks.heartbeatConfig}
      consolidationConfig={systemTasks.consolidationConfig}
      retrospectiveConfig={systemTasks.retrospectiveConfig}
      heartbeatUsage={systemTasks.heartbeatUsage}
      consolidationUsage={systemTasks.consolidationUsage}
      retrospectiveUsage={systemTasks.retrospectiveUsage}
      isLoading={systemTasks.isLoading}
      hasError={systemTasks.hasError}
      onRetry={systemTasks.refetchAll}
      onSelectHeartbeat={() =>
        navigate(routes.settings.schedule(SYSTEM_TASK_URL_IDS.heartbeat))
      }
      onSelectConsolidation={() =>
        navigate(routes.settings.schedule(SYSTEM_TASK_URL_IDS.consolidation))
      }
      onSelectRetrospective={() =>
        navigate(routes.settings.schedule(SYSTEM_TASK_URL_IDS.retrospective))
      }
    />
  );
}
