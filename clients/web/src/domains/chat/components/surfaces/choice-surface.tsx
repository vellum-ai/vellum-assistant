import {
  type ChoiceOption,
  type ChoiceSurfaceData,
  ChoiceSurfaceDataSchema,
} from "@vellumai/assistant-api";
import { OptionCard, OptionCardGroup } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import type { Surface } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";

interface ChoiceSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  /**
   * Assistant that owns the conversation this surface belongs to. Lets
   * workspace file references in the description resolve against its
   * workspace instead of degrading to an inert file card.
   */
  assistantId?: string | null;
}

function buildInitialSelectedIds(
  selectionMode: ChoiceSurfaceData["selectionMode"],
  options: ChoiceOption[],
): Set<string> {
  if (selectionMode !== "multiple") {
    return new Set();
  }
  return new Set(
    options
      .filter((option) => option.recommended === true)
      .map((option) => option.id),
  );
}

function buildChoicePayload(option: ChoiceOption): Record<string, unknown> {
  return {
    choiceId: option.id,
    choiceTitle: option.title,
    selectedIds: [option.id],
    selectedTitles: [option.title],
    ...(option.description ? { choiceDescription: option.description } : {}),
    ...(option.recommended ? { recommended: true } : {}),
    ...(option.data ?? {}),
  };
}

export function ChoiceSurface({
  surface,
  onAction,
  assistantId,
}: ChoiceSurfaceProps) {
  const { t } = useTranslation("chat");
  const titleId = useId();
  // The wire keeps surface `data` opaque; narrow it with the canonical schema
  // (tolerant, so a real payload never fails to parse) rather than an
  // unchecked cast or a re-declared local interface.
  const data = useMemo<ChoiceSurfaceData>(() => {
    const parsed = ChoiceSurfaceDataSchema.safeParse(surface.data);
    return parsed.success
      ? parsed.data
      : { options: [], selectionMode: "single" };
  }, [surface.data]);
  const options = data.options;
  const selectionMode = data.selectionMode;
  const commitOnSelect =
    selectionMode === "single" ? data.commitOnSelect !== false : false;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
    buildInitialSelectedIds(selectionMode, options),
  );
  const [submitting, setSubmitting] = useState<string | null>(null);

  const selectedOptions = useMemo(
    () => options.filter((option) => selectedIds.has(option.id)),
    [options, selectedIds],
  );

  const submitOption = async (option: ChoiceOption) => {
    if (submitting) {
      return;
    }
    setSubmitting(option.id);
    try {
      await onAction(surface.surfaceId, option.id, buildChoicePayload(option));
    } catch {
      setSubmitting(null);
    }
  };

  const toggleOption = (option: ChoiceOption) => {
    if (commitOnSelect) {
      void submitOption(option);
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selectionMode === "single") {
        if (next.has(option.id)) {
          next.clear();
        } else {
          next.clear();
          next.add(option.id);
        }
        return next;
      }
      if (next.has(option.id)) {
        next.delete(option.id);
      } else {
        next.add(option.id);
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedOptions.length === 0 || submitting) {
      return;
    }
    setSubmitting("submit");
    try {
      await onAction(surface.surfaceId, "submit", {
        selectedIds: selectedOptions.map((option) => option.id),
        selectedTitles: selectedOptions.map((option) => option.title),
        choices: selectedOptions.map((option) => ({
          id: option.id,
          title: option.title,
          ...(option.description ? { description: option.description } : {}),
          ...(option.recommended ? { recommended: true } : {}),
          ...(option.data ? { data: option.data } : {}),
        })),
      });
    } catch {
      setSubmitting(null);
    }
  };

  return (
    // No panel chrome or padding around the options: the rows carry their own
    // raised surface, so an outer inset only nested one box inside another.
    <div>
      {surface.title && (
        <div
          id={titleId}
          className="text-title-small text-[var(--content-strong)]"
        >
          {surface.title}
        </div>
      )}
      {data.description && (
        <ChatMarkdownMessage
          content={data.description}
          className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]"
          assistantId={assistantId}
        />
      )}

      <OptionCardGroup
        selectionMode={selectionMode === "multiple" ? "multiple" : "single"}
        // A committing choice submits on select, so arrow keys must only move
        // focus: selecting on arrow would submit the second option before a
        // keyboard user could reach the third.
        selectOnFocus={!commitOnSelect}
        disabled={submitting !== null}
        aria-labelledby={surface.title ? titleId : undefined}
        className="[&:not(:first-child)]:mt-3"
      >
        {options.map((option) => {
          const selected = selectedIds.has(option.id);
          return (
            <OptionCard
              key={option.id}
              // Borderless: the row reads as a row because it sits one step
              // up the surface ladder from the chat background
              // (`--background` == `--surface-base`), not because of an
              // outline. Hover takes the ladder's next step.
              variant="filled"
              selected={selected}
              onSelect={() => toggleOption(option)}
              className={
                option.recommended
                  ? "bg-[var(--primary-base)]/10 enabled:hover:bg-[var(--primary-base)]/10"
                  : undefined
              }
              title={
                <>
                  {option.title}
                  {option.recommended && (
                    <span className="rounded-full bg-[var(--primary-base)] px-2 py-0.5 text-label-small-default text-[var(--content-inset)]">
                      {t("choiceSurface.recommended")}
                    </span>
                  )}
                </>
              }
              description={option.description || undefined}
              trailing={
                submitting === option.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : undefined
              }
            />
          );
        })}
      </OptionCardGroup>

      {!commitOnSelect && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={selectedOptions.length === 0 || submitting !== null}
            onClick={handleSubmit}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
          >
            {submitting === "submit" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {data.submitLabel ?? t("choiceSurface.continue")}
          </button>
        </div>
      )}
    </div>
  );
}
