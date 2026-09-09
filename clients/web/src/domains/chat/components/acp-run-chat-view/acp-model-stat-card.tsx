/**
 * MODEL tile in the ACP run detail panel.
 *
 * On a live run the tile is the trigger for the adapter's own model list. The
 * daemon applies a choice through `session/set_config_option`, which the
 * adapter honours from the next turn, so a turn already streaming finishes on
 * the model it started with and the menu says so. A terminal run has nothing
 * left to switch, so its tile is the plain metric card.
 *
 * `ActionMenu` resolves the surface: an anchored dropdown under a pointer, a
 * bottom sheet under a thumb. `MetricCard` is a plain div with no ref, so the
 * trigger wears its chrome (`METRIC_CARD_CLASS` + `MetricCardContent`) on a
 * real button rather than a copy of the same classes.
 */

import { Check, ChevronDown, Sparkles } from "lucide-react";
import { Fragment, useCallback, type ReactNode, type Ref } from "react";

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
import { isActiveAcpStatus } from "@/utils/acp-run-status";
import { badRequestMessage } from "@/utils/api-errors";

const EMPTY_OPTIONS: AcpModelOption[] = [];

/** What the tile needs back from a switch: the daemon's refreshed selection. */
export type AcpModelSelection = Pick<
  SwitchAcpRunModelResponse,
  "model" | "availableModels"
>;

export interface AcpModelStatCardProps {
  entry: AcpRunEntry;
  /** Applies the chosen model to the live session. */
  onSwitchModel: (
    acpSessionId: string,
    model: string,
  ) => Promise<AcpModelSelection>;
  /**
   * Assistant that owns the run, from the panel. The compat gate is scoped to
   * it so a stale run's menu closes the moment the active assistant moves to
   * one whose daemon has no `set-model` route.
   */
  assistantId?: string | null;
  /** Start the menu open. For tests; the panel leaves it closed. */
  defaultOpen?: boolean;
}

/**
 * Whether the MODEL tile renders for a run: the compat gate is open for the
 * run's own assistant, the adapter reported a model, and a live run still has
 * something to switch to. The panel reads it to size its metrics grid, so the
 * grid and the tile cannot disagree about whether there is a third column.
 *
 * The gate is scoped to `assistantId` rather than to whichever assistant is
 * active. During a switch the active id moves before the identity store
 * rehydrates, so an unscoped answer off the outgoing version would leave the
 * stale run's menu enabled and post `set-model` to an assistant that has no
 * such route. No owner id means no gate to check, so the tile stays hidden.
 */
export function useShowsAcpModelCard(
  entry: AcpRunEntry,
  assistantId: string | null | undefined,
): boolean {
  const supported = useAssistantScopedSupportsAcpModelSwitching(assistantId);
  if (!supported || entry.model === undefined) {
    return false;
  }
  if (!isActiveAcpStatus(entry.status)) {
    return true;
  }
  return (entry.availableModels?.length ?? 0) > 0;
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
  assistantId,
  defaultOpen,
}: AcpModelStatCardProps) {
  const { t } = useTranslation("chat");
  const shows = useShowsAcpModelCard(entry, assistantId);
  const { acpSessionId, model } = entry;
  const options = entry.availableModels ?? EMPTY_OPTIONS;

  const handleSelect = useCallback(
    (value: string) => {
      if (value === model) {
        return;
      }
      // Optimistic so the tile reads the user's choice before the round trip,
      // then reconciled against the adapter's refreshed set. Both writes go
      // through the store's `setModel`, which stamps `modelUpdatedAt` and so
      // survives an `/acp/sessions` snapshot fetched before either landed.
      useAcpRunStore
        .getState()
        .setModel({ acpSessionId, model: value, availableModels: options });
      void onSwitchModel(acpSessionId, value)
        .then((next) => {
          useAcpRunStore.getState().setModel({
            acpSessionId,
            model: next.model,
            availableModels: next.availableModels,
          });
        })
        .catch((err: unknown) => {
          useAcpRunStore
            .getState()
            .setModel({ acpSessionId, model, availableModels: options });
          // A 400 is the adapter's verdict on the value, written for the user.
          toast.error(
            badRequestMessage(err) ?? t("acpRunChatView.modelSwitchFailed"),
          );
        });
    },
    [acpSessionId, model, options, onSwitchModel, t],
  );

  if (!shows) {
    return null;
  }

  const label = t("acpRunChatView.modelLabel");
  const value = options.find((o) => o.value === model)?.label ?? model ?? "";
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
        valueClassName="truncate font-mono"
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
          ariaLabel={t("acpRunChatView.modelTriggerAria", { model: value })}
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
                label={
                  <ModelRowLabel
                    option={option}
                    active={option.value === model}
                  />
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
 */
function ModelTileTrigger({
  icon,
  value,
  label,
  ariaLabel,
  ref,
  ...rest
}: {
  icon: ReactNode;
  value: string;
  label: string;
  ariaLabel: string;
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
      )}
      {...rest}
    >
      <MetricCardContent
        icon={icon}
        value={value}
        label={label}
        valueClassName="truncate font-mono"
      />
      <ChevronDown
        className="ml-auto h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
        aria-hidden
      />
    </button>
  );
}

/**
 * One model row: the adapter's label, its description as secondary text, and a
 * check on the selected one. Built as a single label node so both the anchored
 * row and the sheet row show the same thing.
 */
function ModelRowLabel({
  option,
  active,
}: {
  option: AcpModelOption;
  active: boolean;
}) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{option.label}</span>
      {option.description ? (
        <span className="truncate text-label-small-default text-[var(--content-tertiary)]">
          {option.description}
        </span>
      ) : null}
      {active ? (
        <Check
          className="ml-auto h-3.5 w-3.5 shrink-0 self-center text-[var(--system-positive-strong)]"
          aria-hidden
        />
      ) : null}
    </span>
  );
}
