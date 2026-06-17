/**
 * Shared deploy/share dialog UI driven by {@link useDeployStore}.
 *
 * Renders:
 * - **VercelTokenDialog** — shown when a deploy requires a Vercel API token
 * - **ComplexDeployConfirmDialog** — shown when an app uses backend services
 *   and needs a full-stack deploy via the assistant
 *
 * Mount this component wherever deploy actions can be triggered (library page,
 * chat page, etc.). The dialogs are idempotent — only one instance will be
 * visible at a time since they're gated by Zustand store booleans.
 */

import { VercelTokenDialog } from "@/components/vercel-token-dialog";
import { useDeployStore } from "@/stores/deploy-store";
import { ConfirmDialog } from "@vellumai/design-library";

export interface DeployDialogsProps {
  assistantId: string;
  assistantName?: string;
  onStartConversation?: (initialMessage: string) => void;
}

export function DeployDialogs({
  assistantId,
  assistantName,
  onStartConversation,
}: DeployDialogsProps) {
  const isTokenDialogOpen = useDeployStore.use.isTokenDialogOpen();
  const complexDeployApp = useDeployStore.use.complexDeployApp();

  return (
    <>
      <VercelTokenDialog
        open={isTokenDialogOpen}
        onOpenChange={(open) => {
          if (!open) useDeployStore.getState().hideTokenDialog();
        }}
        assistantId={assistantId}
        onTokenSaved={() => {
          void useDeployStore.getState().deployAfterTokenSaved(assistantId);
        }}
      />
      <ConfirmDialog
        open={complexDeployApp !== null}
        title="This app needs a full deploy"
        message={`"${complexDeployApp?.name ?? ""}" uses backend services that won't work on a static Vercel page. ${assistantName ?? "Your assistant"} can deploy it properly with serverless functions.`}
        confirmLabel={`Let ${assistantName ?? "your assistant"} handle it`}
        onConfirm={() => {
          const appName =
            useDeployStore.getState().complexDeployApp?.name ?? "this app";
          useDeployStore.getState().setComplexDeployApp(null);
          onStartConversation?.(
            `Deploy my app "${appName}" to Vercel. It uses backend services that need serverless functions — please use the deploy-fullstack-vercel skill to handle it properly.`,
          );
        }}
        onCancel={() => useDeployStore.getState().setComplexDeployApp(null)}
      />
    </>
  );
}
