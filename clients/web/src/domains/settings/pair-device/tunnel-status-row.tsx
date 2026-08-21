import { Button } from "@vellumai/design-library/components/button";
import { RefreshCw } from "lucide-react";

import { currentLocale, Trans, type TFunction, useTranslation } from "@/i18n";
import { formatRelativeTime } from "@/lib/relative-time";

/**
 * What the Pair-a-device card knows about the tunnel right now. Local to this
 * component rather than the generated SDK type: the row is presentation, and
 * the hook that talks to the daemon maps the wire response onto it.
 */
export type TunnelStatusView =
  | { kind: "checking" }
  | { kind: "unconfigured" }
  | { kind: "stopped"; provider: string; publicBaseUrl: string }
  | { kind: "healthy"; publicBaseUrl: string; checkedAt: string }
  | { kind: "unreachable"; publicBaseUrl: string; checkedAt: string }
  | {
      kind: "foreign";
      publicBaseUrl: string;
      checkedAt: string;
      servingAssistantName?: string;
    };

/** Every state the row actually draws; `unconfigured` renders nothing. */
type RenderedTunnelStatus = Exclude<TunnelStatusView, { kind: "unconfigured" }>;

/** The public address a status reports, or `null` in the states carrying none. */
export function statusPublicBaseUrl(status: TunnelStatusView): string | null {
  return "publicBaseUrl" in status ? status.publicBaseUrl : null;
}

interface TunnelStatusRowProps {
  status: TunnelStatusView;
  /** Re-runs the daemon-side probe. The row owns no fetching of its own. */
  onRefresh: () => void;
  isRefreshing: boolean;
}

const DOT_COLOR: Record<RenderedTunnelStatus["kind"], string> = {
  checking: "var(--content-tertiary)",
  stopped: "var(--content-tertiary)",
  healthy: "var(--system-positive-strong)",
  unreachable: "var(--system-mid-strong)",
  foreign: "var(--system-negative-strong)",
};

/** The command that restarts the tunnel the stopped record came from. */
function restartCommand(provider: string): string {
  return `vellum tunnel --provider ${provider}`;
}

/**
 * One compact line reporting whether this assistant's public address is
 * actually serving it: a tone dot, a sentence, the address, when it was last
 * checked, and a manual re-check.
 *
 * Pure by design: props in, markup out. Fetching, the `app.resume` re-check
 * and any polling belong to the card above it, per `docs/EVENT_BUS.md`.
 * Renders nothing for `unconfigured`, which the card covers with its
 * first-run notice.
 */
export function TunnelStatusRow({
  status,
  onRefresh,
  isRefreshing,
}: TunnelStatusRowProps) {
  const { t } = useTranslation("settings");

  if (status.kind === "unconfigured") {
    return null;
  }

  const busy = status.kind === "checking" || isRefreshing;
  const checkedAt = "checkedAt" in status ? status.checkedAt : null;
  const publicBaseUrl = statusPublicBaseUrl(status);

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[var(--border-element)] px-3 py-2.5">
      <span
        aria-hidden
        className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: DOT_COLOR[status.kind] }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body-small-default text-[var(--content-default)]">
          {statusSentence(status, t)}
        </p>
        {status.kind === "stopped" && (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            <Trans
              i18nKey="tunnelStatusRow.stoppedRestart"
              ns="settings"
              values={{ command: restartCommand(status.provider) }}
              components={{
                code: (
                  <code className="rounded-md bg-[var(--surface-active)] px-1.5 py-0.5 text-[color:var(--content-primary)]" />
                ),
              }}
            />
          </p>
        )}
        {publicBaseUrl && (
          <p
            className="truncate text-body-small-default text-[var(--content-tertiary)]"
            title={publicBaseUrl}
          >
            {publicBaseUrl}
          </p>
        )}
        {checkedAt && (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {t("tunnelStatusRow.checkedAt", {
              when: formatRelativeTime(new Date(checkedAt).getTime(), {
                locale: currentLocale(),
              }),
            })}
          </p>
        )}
      </div>
      <Button
        variant="ghost"
        size="compact"
        iconOnly={<RefreshCw className={busy ? "animate-spin" : undefined} />}
        aria-label={t("tunnelStatusRow.refreshLabel")}
        disabled={busy}
        onClick={onRefresh}
      />
    </div>
  );
}

/** Keys are written out per state so the catalog's orphan check can see them. */
function statusSentence(
  status: RenderedTunnelStatus,
  t: TFunction<"settings">,
): string {
  switch (status.kind) {
    case "checking":
      return t("tunnelStatusRow.checkingStatus");
    case "stopped":
      return t("tunnelStatusRow.stoppedStatus");
    case "healthy":
      return t("tunnelStatusRow.healthyStatus");
    case "unreachable":
      return t("tunnelStatusRow.unreachableStatus");
    case "foreign":
      return status.servingAssistantName
        ? t("tunnelStatusRow.foreignStatusNamed", {
            name: status.servingAssistantName,
          })
        : t("tunnelStatusRow.foreignStatus");
  }
}
