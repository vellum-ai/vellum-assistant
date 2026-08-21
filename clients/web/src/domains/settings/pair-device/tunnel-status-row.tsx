import { cn } from "@vellumai/design-library/utils/cn";

import { Trans, type TFunction, useTranslation } from "@/i18n";

import { CODE_CHIP_CLASS } from "./code-chip";
import { formatRelativeAge } from "./relative-age";
import { TunnelRecheckButton } from "./tunnel-recheck-button";

/**
 * What the Pair-a-device card knows about the tunnel right now. Local to this
 * component rather than the generated SDK type: the row is presentation, and
 * the hook that talks to the daemon maps the wire response onto it.
 */
export type TunnelStatusView =
  | { kind: "checking" }
  | { kind: "unconfigured" }
  /** No verdict to report: the probe never ran, or it gave up. */
  | { kind: "unavailable" }
  | {
      kind: "stopped";
      /** Provider of the tunnel on record, when the daemon remembers one. */
      provider?: string;
      /** Address that tunnel served, when the daemon remembers one. */
      publicBaseUrl?: string;
    }
  | { kind: "healthy"; publicBaseUrl: string; checkedAt: string }
  /**
   * An address the card cannot pair against: `unpairable` answers without
   * serving the pairing app, `unreachable` does not answer at all. One shape,
   * because the row draws them alike and both end in the same restart.
   */
  | {
      kind: "unpairable" | "unreachable";
      publicBaseUrl: string;
      checkedAt: string;
      /** Short, already-redacted diagnostic from the daemon. Not localized. */
      detail?: string;
      /** Provider of the tunnel on record, when the daemon remembers one. */
      provider?: string;
    }
  | {
      kind: "foreign";
      publicBaseUrl: string;
      checkedAt: string;
      servingAssistantName?: string;
      /** Provider of the tunnel on record, when the daemon remembers one. */
      provider?: string;
    };

/** Every state the row actually draws; the card covers the other two itself. */
type RenderedTunnelStatus = Exclude<
  TunnelStatusView,
  { kind: "unconfigured" | "unavailable" }
>;

/**
 * The public address a status reports, or `null` in the states carrying none.
 * An empty address is none: the wire marks the field optional across every
 * state, so a probed verdict without one must not read as an address.
 */
export function statusPublicBaseUrl(status: TunnelStatusView): string | null {
  return "publicBaseUrl" in status && status.publicBaseUrl
    ? status.publicBaseUrl
    : null;
}

/** When the probe last answered, or `null` in the states carrying no check. */
export function statusCheckedAt(status: TunnelStatusView): string | null {
  return "checkedAt" in status && status.checkedAt ? status.checkedAt : null;
}

/**
 * The command that starts this assistant's tunnel. Names the assistant where
 * one is known: on a computer running several, an unnamed `vellum tunnel`
 * may start a different assistant's tunnel than the card is reporting on.
 */
export function tunnelStartCommand(
  provider: string,
  assistantName: string | null,
): string {
  const name = assistantName?.trim();
  return name
    ? `vellum tunnel ${shellArg(name)} --provider ${provider}`
    : `vellum tunnel --provider ${provider}`;
}

/** Names that survive a shell verbatim; everything else has to be quoted. */
const SHELL_SAFE_ARG = /^[A-Za-z0-9._-]+$/;

/**
 * A free-form assistant name as one shell word. The card offers this command
 * for pasting into a terminal, so a name is single-quoted unless it is plainly
 * inert: single quotes are the only ones that also neutralize `$`, backticks
 * and backslashes, and an embedded one closes the quote, escapes itself, and
 * reopens.
 */
function shellArg(value: string): string {
  return SHELL_SAFE_ARG.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

interface TunnelStatusRowProps {
  status: TunnelStatusView;
  /** Re-runs the daemon-side probe. The row owns no fetching of its own. */
  onRefresh: () => void;
  isRefreshing: boolean;
  /** Assistant the restart command should name, when the card knows one. */
  assistantName?: string | null;
}

const DOT_COLOR: Record<RenderedTunnelStatus["kind"], string> = {
  checking: "var(--content-tertiary)",
  stopped: "var(--content-tertiary)",
  healthy: "var(--system-positive-strong)",
  unpairable: "var(--system-mid-strong)",
  unreachable: "var(--system-mid-strong)",
  foreign: "var(--system-negative-strong)",
};

const SUBDUED_CLASS = "text-body-small-default text-[var(--content-tertiary)]";
const SUBDUED_TRUNCATE_CLASS = `truncate ${SUBDUED_CLASS}`;

/**
 * One compact line reporting whether this assistant's public address is
 * actually serving it: a tone dot, a sentence, the address, when it was last
 * checked, and a manual re-check. Every state the daemon has a tunnel on
 * record for also prints the command that starts it again, since a dead
 * address and a stopped tunnel have the same fix.
 *
 * Pure by design: props in, markup out. Fetching, the `app.resume` re-check
 * and the tick that keeps the check age current all belong to the card above
 * it, per `docs/EVENT_BUS.md`.
 * Renders nothing for `unconfigured` or `unavailable`: with no tunnel and
 * with no verdict there is nothing to report, and the card speaks instead. Its
 * first-run notice carries the same {@link TunnelRecheckButton} for the state
 * this row draws nothing for.
 */
export function TunnelStatusRow({
  status,
  onRefresh,
  isRefreshing,
  assistantName = null,
}: TunnelStatusRowProps) {
  const { t } = useTranslation("settings");

  if (status.kind === "unconfigured" || status.kind === "unavailable") {
    return null;
  }

  const checkedAt = statusCheckedAt(status);
  const publicBaseUrl = statusPublicBaseUrl(status);
  const provider = "provider" in status ? status.provider : undefined;
  const detail = "detail" in status ? status.detail : undefined;

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
        {/* The daemon's own words for the failure: already redacted, and not
            translated, so it sits beside the sentence rather than inside it. */}
        {detail && (
          <p className={SUBDUED_TRUNCATE_CLASS} title={detail}>
            {detail}
          </p>
        )}
        {provider && (
          <p className={SUBDUED_CLASS}>
            <Trans
              i18nKey={
                status.kind === "stopped"
                  ? "tunnelStatusRow.stoppedRestart"
                  : "tunnelStatusRow.restartHint"
              }
              ns="settings"
              values={{ command: tunnelStartCommand(provider, assistantName) }}
              components={{
                code: <code className={cn(CODE_CHIP_CLASS, "px-1.5 py-0.5")} />,
              }}
            />
          </p>
        )}
        {publicBaseUrl && (
          <p className={SUBDUED_TRUNCATE_CLASS} title={publicBaseUrl}>
            {publicBaseUrl}
          </p>
        )}
        {checkedAt && (
          <p className={SUBDUED_CLASS}>
            {t("tunnelStatusRow.checkedAt", {
              when: formatRelativeAge(checkedAt),
            })}
          </p>
        )}
      </div>
      <TunnelRecheckButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
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
    case "unpairable":
      return t("tunnelStatusRow.unpairableStatus");
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
