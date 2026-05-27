
import { AlertTriangle, Loader2 } from "lucide-react";
import { Link } from "react-router";
import type { FC, ReactNode } from "react";

import { Button, Modal, Typography } from "@vellum/design-library";
import type {
  ConnectionServerState,
  ReachabilityState,
} from "@/assistant/use-assistant-reachability";
import { MAX_ATTEMPTS } from "@/assistant/use-assistant-reachability";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store";
import { routes } from "@/utils/routes";

interface ConnectingToAssistantProps {
  state: ReachabilityState;
  onRetry: () => void;
  onDismiss: () => void;
}

// One-off frosted backdrop: the default Modal overlay is a flat black/50,
// which felt heavy for a transient connectivity state. A subtle blur +
// lighter tint keeps the page visible so the user can see we haven't
// navigated away.
const BLUR_OVERLAY_CLASS =
  "bg-black/40 backdrop-blur-sm supports-[backdrop-filter]:bg-black/25";

export const ConnectingToAssistant: FC<ConnectingToAssistantProps> = ({
  state,
  onRetry,
  onDismiss,
}) => {
  const isConnecting = state.phase === "connecting";
  const isFailed = state.phase === "failed";
  const open = isConnecting || isFailed;

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && open) {
          onDismiss();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton={false}
        overlayClassName={BLUR_OVERLAY_CLASS}
        data-testid="connecting-to-assistant-overlay"
      >
        {isConnecting ? (
          <ConnectingBody
            attempt={state.attempt}
            isPodWaking={state.isPodWaking}
          />
        ) : null}
        {isFailed ? (
          <FailureBody
            detail={state.detail}
            lastServerState={state.lastServerState}
            onRetry={onRetry}
          />
        ) : null}
      </Modal.Content>
    </Modal.Root>
  );
};

interface ConnectingBodyProps {
  attempt: number;
  isPodWaking: boolean;
}

const ConnectingBody: FC<ConnectingBodyProps> = ({ attempt, isPodWaking }) => {
  const heading = isPodWaking
    ? "Bringing your assistant back online"
    : "Connecting to your assistant";
  const description = isPodWaking
    ? "Your assistant is starting and should be reachable shortly. This can take up to a minute."
    : "We're having trouble reaching your assistant and will keep retrying for up to 60 seconds.";
  // ``attempt`` counts completed probe attempts (0 before the first probe
  // has resolved). Display the human-facing "in-progress" attempt number
  // which is one greater.
  const statusLabel = isPodWaking
    ? null
    : `Attempt ${Math.min(attempt + 1, MAX_ATTEMPTS)} of ${MAX_ATTEMPTS}`;

  return (
    <StatusLayout
      icon={
        <StatusIcon tone="info">
          <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
        </StatusIcon>
      }
      title={heading}
      description={description}
      status={statusLabel}
    />
  );
};

interface FailureBodyProps {
  detail: string | null;
  lastServerState: ConnectionServerState | null;
  onRetry: () => void;
}

const FailureBody: FC<FailureBodyProps> = ({
  detail,
  lastServerState,
  onRetry,
}) => {
  const doctorEnabled = useClientFeatureFlagStore.use.doctor();
  const isCrashLoop = lastServerState === "crash_loop";

  const title = isCrashLoop
    ? "Your assistant hit an error"
    : "Couldn't connect to your assistant";
  const description = isCrashLoop
    ? doctorEnabled
      ? "Your assistant reported an error while starting. Try running the Doctor to diagnose the issue. Please contact support if the problem persists."
      : "Your assistant reported an error while starting. Please contact support if the problem persists."
    : doctorEnabled
      ? `We tried ${MAX_ATTEMPTS} times over 60 seconds and still can't reach your assistant. Try running the Doctor to diagnose the issue. Please contact support if the problem persists.`
      : `We tried ${MAX_ATTEMPTS} times over 60 seconds and still can't reach your assistant. Please contact support if the problem persists.`;

  return (
    <StatusLayout
      icon={
        <StatusIcon tone="warning">
          <AlertTriangle className="h-7 w-7" aria-hidden="true" />
        </StatusIcon>
      }
      title={title}
      description={description}
      status={detail}
      actions={
        <>
          <Button
            variant="primary"
            onClick={onRetry}
            data-testid="connection-retry-button"
          >
            Try again
          </Button>
          {doctorEnabled ? (
            <Button
              asChild
              variant="outlined"
              data-testid="connection-go-to-doctor-button"
            >
              <Link to={`${routes.settings.debug}?tab=doctor`}>
                Go to Doctor
              </Link>
            </Button>
          ) : (
            <Button
              asChild
              variant="outlined"
              data-testid="connection-contact-support-button"
            >
              <a href="mailto:support@vellum.ai">Contact support</a>
            </Button>
          )}
        </>
      }
    />
  );
};

interface StatusLayoutProps {
  icon: ReactNode;
  title: string;
  description: string;
  status: string | null;
  actions?: ReactNode;
}

const StatusLayout: FC<StatusLayoutProps> = ({
  icon,
  title,
  description,
  status,
  actions,
}) => {
  return (
    <div className="flex flex-col items-center gap-6 px-6 pt-8 pb-6 text-center">
      {icon}
      <div className="flex flex-col items-center gap-3">
        <Modal.Title className="[&>span]:!overflow-visible">{title}</Modal.Title>
        <Modal.Description className="mt-0">{description}</Modal.Description>
      </div>
      {status ? (
        <Typography
          variant="label-small-default"
          as="p"
          className="text-(--content-secondary)"
        >
          {status}
        </Typography>
      ) : null}
      {actions ? (
        <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
          {actions}
        </div>
      ) : null}
    </div>
  );
};

interface StatusIconProps {
  tone: "info" | "warning";
  children: ReactNode;
}

const StatusIcon: FC<StatusIconProps> = ({ tone, children }) => {
  const toneClass =
    tone === "warning"
      ? "bg-[color-mix(in_oklab,var(--system-mid-strong)_16%,transparent)] text-(--system-mid-strong) ring-[color-mix(in_oklab,var(--system-mid-strong)_24%,transparent)]"
      : "bg-[color-mix(in_oklab,var(--primary-base)_16%,transparent)] text-(--primary-base) ring-[color-mix(in_oklab,var(--primary-base)_24%,transparent)]";
  return (
    <div
      aria-hidden="true"
      className={`flex h-14 w-14 items-center justify-center rounded-full ring-1 ring-inset ${toneClass}`}
    >
      {children}
    </div>
  );
};
