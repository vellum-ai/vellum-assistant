/**
 * Right-hand side-drawer holding everything a wake card folds away: what the
 * wake reported, and the metadata (its source) the card no longer shows.
 *
 * The card in the transcript keeps a one-line recap, so this panel is where
 * the run detail and the result payload live. A workflow hint arrives as four
 * lines the daemon wrote for a model to read, and they are split back into the
 * fields they describe rather than shown as one block: the workflow's name,
 * the run's status, and the result. Anything that does not parse into those,
 * which is every non-workflow wake, comes back whole under one heading.
 *
 * Driven by `activeWakeDetail` in `viewer-store` (see `openWakeDetail`).
 * Rendered inside the shared chat `AnimatedRightDrawer` by
 * `chat-content-layout`, matching its sibling `SkillDetailPanel`.
 */

import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { DetailShell } from "@/components/detail-shell";
import {
  parseResultPayload,
  parseWakeHint,
} from "@/domains/chat/components/surfaces/wake-card-presentation";
import { useTranslation } from "@/i18n";
import type { WakeDetailPayload } from "@/stores/viewer-store";

interface WakeDetailPanelProps {
  payload: WakeDetailPayload;
  onClose: () => void;
}

export function WakeDetailPanel({ payload, onClose }: WakeDetailPanelProps) {
  const { t } = useTranslation("chat");
  const sections = parseWakeHint(payload.body);

  return (
    <DetailShell
      Glyph={Sparkles}
      title={payload.title || t("wakeDetailPanel.title")}
      closeLabel={t("wakeDetailPanel.close")}
      closeTooltip={t("wakeDetailPanel.close")}
      closeVariant="outlined"
      onClose={onClose}
    >
      <dl className="flex flex-col gap-6">
        {sections.workflow && (
          <DetailField label={t("wakeDetailPanel.workflow")}>
            {sections.workflow}
          </DetailField>
        )}

        {sections.runStatus && (
          <DetailField label={t("wakeDetailPanel.runStatus")}>
            <span className="whitespace-pre-wrap break-words">
              {sections.runStatus}
            </span>
          </DetailField>
        )}

        {sections.result && (
          <DetailField label={t("wakeDetailPanel.result")}>
            <ResultBody result={sections.result} />
          </DetailField>
        )}

        {sections.rest && (
          <DetailField label={t("wakeDetailPanel.details")}>
            {/* A non-workflow hint's own line breaks are its structure, so it
                is preserved rather than reflowed. */}
            <span className="whitespace-pre-wrap break-words">
              {sections.rest}
            </span>
          </DetailField>
        )}

        {payload.metadata.length > 0 && (
          <div className="flex flex-col gap-6">
            {payload.metadata.map((item) => (
              <DetailField key={item.label} label={item.label}>
                {item.value}
              </DetailField>
            ))}
          </div>
        )}
      </dl>
    </DetailShell>
  );
}

/**
 * A workflow's result: labelled rows where it is JSON the panel can lay out,
 * and the text that arrived where it is not. A truncated tail is the common
 * not-JSON case, since the daemon caps the result it echoes into a hint and a
 * long one ends mid-payload with a marker saying where to fetch the rest.
 */
function ResultBody({ result }: { result: string }) {
  const groups = parseResultPayload(result);

  if (!groups) {
    return <span className="whitespace-pre-wrap break-words">{result}</span>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((rows, index) => (
        <div
          key={index}
          // Later groups are ruled off from the one above rather than each
          // sitting in a box of its own, so a single-object result, which is
          // most of them, draws no chrome at all.
          className={
            index > 0
              ? "flex flex-col gap-2 border-t border-[var(--border-hover)] pt-4"
              : "flex flex-col gap-2"
          }
        >
          {rows.map((row) => (
            <div key={row.key} className="flex flex-col gap-0.5">
              <span className="text-body-small-default text-[var(--content-tertiary)]">
                {row.key}
              </span>
              <span className="whitespace-pre-wrap break-words">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * One labelled field: a quiet label over the value it names. Every row in this
 * panel wears it, so the hint's own fields read as siblings of the metadata
 * under them rather than as loose text with fields appended.
 */
function DetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-label-medium-default text-[var(--content-tertiary)]">
        {label}
      </dt>
      <dd className="text-body-medium-default text-[var(--content-default)]">
        {children}
      </dd>
    </div>
  );
}
