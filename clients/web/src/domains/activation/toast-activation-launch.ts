/**
 * What a checklist launch says once it has settled.
 *
 * Success names the sidebar thread and offers it. A failure that already
 * linked a conversation offers that thread back. A launch with nothing to
 * report (the same task already running) stays quiet.
 */

import { toast } from "@vellumai/design-library/components/toast";

import type { TFunction } from "@/i18n";

import type { LaunchActivationTaskResult } from "./hooks/use-launch-activation-task";

export function toastActivationLaunchResult(
  result: LaunchActivationTaskResult,
  t: TFunction<"activation">,
  onOpenConversation: (conversationId: string) => void,
): void {
  if (result.ok) {
    toast.success(t("launch.running"), {
      ...(result.conversationId
        ? {
            action: {
              label: t("row.open"),
              onClick: () => onOpenConversation(result.conversationId!),
            },
          }
        : {}),
    });
    return;
  }
  if (!result.error) {
    return;
  }
  toast.error(result.error, {
    ...(result.conversationId
      ? {
          action: {
            label: t("launch.openConversation"),
            onClick: () => onOpenConversation(result.conversationId!),
          },
        }
      : {}),
  });
}
