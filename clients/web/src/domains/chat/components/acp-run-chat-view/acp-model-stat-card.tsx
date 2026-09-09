/**
 * MODEL tile in the ACP run detail panel.
 *
 * On a live run the tile is the trigger for the adapter's own model list. The
 * daemon applies a choice through `session/set_config_option`, which the
 * adapter honours from the next turn, so a turn already streaming finishes on
 * the model it started with and the menu says so. A terminal run has nothing
 * left to switch, so its tile is the plain metric card.
 *
 * A switch is sequenced rather than optimistic: the chosen label shows as
 * pending and the store is written only from the daemon's answer. An
 * optimistic write races every other writer of the same field. A rehydration
 * fetch issued after it reads the daemon before `set-model` applies and rolls
 * the tile back; a revert on failure clobbers whatever the session's own
 * stream wrote in between.
 *
 * `ActionMenu` resolves the surface: an anchored dropdown under a pointer, a
 * bottom sheet under a thumb. `MetricCard` is a plain div with no ref, so the
 * trigger wears its chrome (`METRIC_CARD_CLASS` + `MetricCardContent`) on a
 * real button rather than a copy of the same classes.
 */

import { Check, ChevronDown, Sparkles } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

import { ActionMenu, cn, toast } from "@vellumai/design-library";

import {
  useAcpRunStore,
  type AcpModelOption,
  type AcpRunEntry,
} from "@/domains/chat/acp-run-store";
import {
  METRIC_CARD_CLASS,
  MetricCard,
  MetricCardContent,
} from "@/domains/chat/components/metric-card";
import type { SwitchAcpRunModelResponse } from "@/domains/chat/utils/acp-run-actions";
import { useTranslation } from "@/i18n";
import { useAssistantScopedSupportsAcpModelSwitching } from "@/lib/backwards-compat/acp-model-switching";
import { captureError } from "@/lib/sentry/capture-error";
import { isActiveAcpStatus } from "@/utils/acp-run-status";
import { rejectionMessage } from "@/utils/api-errors";

const EMPTY_OPTIONS: AcpModelOption[] = [];

/** What the tile needs back from a switch: the daemon's refreshed selection. */
type AcpModelSelection = Pick<
  SwitchAcpRunModelResponse,
  "model" | "availableModels"
>;

interface AcpModelStatCardProps {
  entry: AcpRunEntry;
  /** Applies the chosen model to the live session. */
  onSwitchModel: (
    acpSessionId: string,
    model: string,
  ) => Promise<AcpModelSelection>;
  /** Start the menu open. For tests; the panel leaves it closed. */
  defaultOpen?: boolean;
}

/**
 * Whether the MODEL tile renders for a run: the compat gate is open for the
 * active assistant, and there is something to show. A live run needs the
 * adapter's option list, since the tile is a picker; a terminal run needs only
 * the model it ran on, which it shows as a plain metric.
 *
 * The list is what the gate reads, not the reported current value: an adapter
 * that offers a full list with an empty `currentValue` still has a switch
 * worth offering, and a run whose list is empty has none however it answered.
 *
 * `assistantId` is the assistant the panel is looking at, which is the one
 * `set-model` would post to. The gate closes when the version the identity
 * store holds was fetched for a different assistant, or for one whose daemon
 * has no such route, so the menu cannot outlive the assistant that serves it.
 *
 * The panel reads this to size its metrics grid, so the grid and the tile
 * cannot disagree about whether there is a model column.
 */
export function useShowsAcpModelCard(
  entry: AcpRunEntry,
  assistantId: string | null | undefined,
): boolean {
  const supported = useAssistantScopedSupportsAcpModelSwitching(assistantId);
  if (!supported) {
    return false;
  }
  if (isActiveAcpStatus(entry.status)) {
    return (entry.availableModels?.length ?? 0) > 0;
  }
  return entry.model !== undefined;
}

/** Options in adapter order, split at each change of the group they name. */
function groupOptions(
  options: AcpModelOption[],
): { group?: string; items: AcpModelOption[] }[] {
  const groups: { group?: string; items: AcpModelOption[] }[] = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.group === option.group) {
      last.items.push(option);
      continue;
    }
    groups.push({ group: option.group, items: [option] });
  }
  return groups;
}

export function AcpModelStatCard({
  entry,
  onSwitchModel,
  defaultOpen,
}: AcpModelStatCardProps) {
  const { t } = useTranslation("chat");
  const { acpSessionId, model } = entry;
  const options = entry.availableModels ?? EMPTY_OPTIONS;

  // The chosen model while its switch is in flight. Local, so nothing else
  // reads a value the daemon has not confirmed.
  const [pendingValue, setPendingValue] = useState<string | null>(null);
  // Which request the tile is waiting on. A response from any earlier one is a
  // stale answer about a model nobody is switching to any more.
  const requestRef = useRef(0);

  // The panel reuses one tile across runs, so a run switch retires whatever is
  // in flight: its answer belongs to the run that asked, not to this one.
  useEffect(() => {
    requestRef.current += 1;
    setPendingValue(null);
  }, [acpSessionId]);

  const handleSelect = useCallback(
    (value: string) => {
      if (value === model || pendingValue !== null) {
        return;
      }
      // The request goes out first: it resolves the active assistant, and a
      // missing one must reject rather than latch the menu shut.
      const request = onSwitchModel(acpSessionId, value);
      const requestId = ++requestRef.current;
      setPendingValue(value);
      void request
        .then((next) => {
          if (requestId !== requestRef.current) {
            return;
          }
          setPendingValue(null);
          // The store is written once, from the daemon's answer, through the
          // action that stamps `modelUpdatedAt` so an `/acp/sessions` snapshot
          // fetched before the switch landed cannot overwrite it.
          useAcpRunStore.getState().setModel({
            acpSessionId,
            model: next.model,
            availableModels: next.availableModels,
          });
        })
        .catch((err: unknown) => {
          if (requestId !== requestRef.current) {
            return;
          }
          setPendingValue(null);
          // A 400 is the adapter's verdict on the value and a 409 says it no
          // longer offers a choice at all. Both are written for the user.
          // Anything else is a bug on our side, so it reaches Sentry too.
          const rejection = rejectionMessage(err);
          if (rejection === undefined) {
            captureError(err, { context: "AcpModelStatCard.switchModel" });
          }
          toast.error(rejection ?? t("acpRunChatView.modelSwitchFailed"));
        });
    },
    [acpSessionId, model, onSwitchModel, pendingValue, t],
  );

  const label = t("acpRunChatView.modelLabel");
  const shown = pendingValue ?? model;
  // An adapter can offer a list without naming a current value. The tile says
  // which model that leaves the run on rather than rendering an empty row and
  // announcing "Model: . Change model".
  const named = options.find((o) => o.value === shown)?.label ?? shown;
  const value = named || t("acpRunChatView.modelUnset");
  const icon = (
    <Sparkles
      className="h-4 w-4 shrink-0"
      style={{ color: "var(--content-secondary)" }}
    />
  );

  if (!isActiveAcpStatus(entry.status)) {
    return (
      <MetricCard
        icon={icon}
        value={value}
        label={label}
        valueClassName="font-mono"
      />
    );
  }

  return (
    <ActionMenu.Root defaultOpen={defaultOpen}>
      <ActionMenu.Trigger asChild>
        <ModelTileTrigger
          icon={icon}
          value={value}
          label={label}
          ariaLabel={
            named
              ? t("acpRunChatView.modelTriggerAria", { model: named })
              : t("acpRunChatView.modelTriggerAriaUnset")
          }
          pending={pendingValue !== null}
        />
      </ActionMenu.Trigger>
      <ActionMenu.Content
        title={t("acpRunChatView.modelMenuTitle")}
        align="start"
      >
        {groupOptions(options).map(({ group, items }, index) => (
          <Fragment key={`${index}-${group ?? ""}`}>
            {group ? <ActionMenu.Label>{group}</ActionMenu.Label> : null}
            {items.map((option) => (
              <ActionMenu.Item
                key={option.value}
                // The selected state rides the label, which both presentations
                // render; `trailing` is the anchored menu's column alone, so a
                // check placed only there leaves the sheet row unmarked.
                label={
                  option.value === model ? (
                    <>
                      {option.label}{" "}
                      <span className="sr-only">
                        {t("acpRunChatView.modelSelectedAria")}
                      </span>
                    </>
                  ) : (
                    option.label
                  )
                }
                description={option.description}
                trailing={
                  option.value === model ? (
                    <Check
                      className="h-3.5 w-3.5 shrink-0 text-[var(--system-positive-strong)]"
                      aria-hidden
                    />
                  ) : null
                }
                onSelect={() => handleSelect(option.value)}
              />
            ))}
          </Fragment>
        ))}
        <ActionMenu.Separator />
        <ActionMenu.Label className="normal-case tracking-normal">
          {t("acpRunChatView.modelNextTurnHint")}
        </ActionMenu.Label>
      </ActionMenu.Content>
    </ActionMenu.Root>
  );
}

/**
 * The tile as a button, so Radix can hand it the trigger's ref and ARIA state.
 * `ref` is a plain prop, matching the design library's own controls.
 *
 * `pending` dims the value and says the trigger is unavailable through
 * `aria-disabled`, not the native attribute: the menu closes in the same
 * commit the switch starts, and a trigger that goes `disabled` there cannot
 * take Radix's focus return, so keyboard focus falls to the body for the whole
 * round trip. `handleSelect` is what actually refuses a second choice.
 */
function ModelTileTrigger({
  icon,
  value,
  label,
  ariaLabel,
  pending,
  ref,
  ...rest
}: {
  icon: ReactNode;
  value: string;
  label: string;
  ariaLabel: string;
  pending: boolean;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      className={cn(
        METRIC_CARD_CLASS,
        "w-full cursor-pointer text-left transition-colors",
        "hover:bg-[var(--surface-hover)]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]",
        "data-[pending]:cursor-default data-[pending]:hover:bg-[var(--surface-overlay)]",
      )}
      {...rest}
      aria-disabled={pending || undefined}
      data-pending={pending ? "" : undefined}
    >
      <MetricCardContent
        icon={icon}
        value={value}
        label={label}
        valueClassName={cn("font-mono", pending && "opacity-60")}
      />
      <ChevronDown
        className="ml-auto h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
    </button>
  );
}
