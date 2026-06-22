import { Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import type { Surface } from "@/domains/chat/types/types";

interface ChoiceOption {
  id: string;
  title: string;
  description?: string;
  recommended?: boolean;
  data?: Record<string, unknown>;
}

interface ChoiceSurfaceData {
  description?: string;
  options?: ChoiceOption[];
  selectionMode?: "single" | "multiple";
  commitOnSelect?: boolean;
  submitLabel?: string;
}

interface ChoiceSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

const EMPTY_OPTIONS: ChoiceOption[] = [];

function buildInitialSelectedIds(
  selectionMode: ChoiceSurfaceData["selectionMode"],
  options: ChoiceOption[],
): Set<string> {
  if (selectionMode !== "multiple") return new Set();
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

export function ChoiceSurface({ surface, onAction }: ChoiceSurfaceProps) {
  const data = surface.data as ChoiceSurfaceData;
  const options = data.options ?? EMPTY_OPTIONS;
  const selectionMode = data.selectionMode ?? "single";
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
    if (submitting) return;
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
    if (selectedOptions.length === 0 || submitting) return;
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
    <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-lift)] p-4">
      {surface.title && (
        <div className="text-title-small text-[var(--content-strong)]">
          {surface.title}
        </div>
      )}
      {data.description && (
        <ChatMarkdownMessage
          content={data.description}
          className="mt-1 text-body-medium-lighter text-[var(--content-quiet)]"
        />
      )}

      <div className="mt-3 grid gap-2">
        {options.map((option) => {
          const selected = selectedIds.has(option.id);
          const optionSubmitting = submitting === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              disabled={submitting !== null}
              onClick={() => toggleOption(option)}
              className={[
                "group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
                option.recommended
                  ? "border-[var(--primary-base)] bg-[var(--primary-base)]/10"
                  : "border-[var(--border-element)] bg-[var(--surface-base)] hover:bg-[var(--surface-hover)]",
                selected ? "ring-1 ring-[var(--primary-base)]" : "",
                submitting !== null ? "opacity-70" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                  selected
                    ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
                    : option.recommended
                      ? "border-[var(--primary-base)] bg-[var(--surface-base)]"
                      : "border-[var(--border-element)]",
                ].join(" ")}
              >
                {optionSubmitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : selected ? (
                  <Check className="h-3.5 w-3.5" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-body-medium-default text-[var(--content-strong)]">
                    {option.title}
                  </span>
                  {option.recommended && (
                    <span className="rounded-full bg-[var(--primary-base)] px-2 py-0.5 text-label-small-default text-[var(--content-inset)]">
                      Recommended
                    </span>
                  )}
                </span>
                {option.description && (
                  <span className="mt-1 block text-body-small-default text-[var(--content-quiet)]">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {!commitOnSelect && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={selectedOptions.length === 0 || submitting !== null}
            onClick={handleSubmit}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--primary-base)] px-4 py-2 text-body-medium-default text-[var(--content-inset)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting === "submit" && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            {data.submitLabel ?? "Continue"}
          </button>
        </div>
      )}
    </div>
  );
}
