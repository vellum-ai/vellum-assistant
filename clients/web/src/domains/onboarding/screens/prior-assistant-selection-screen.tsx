import { Check, ChevronLeft, MoreHorizontal, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    PRECHAT_PRIOR_ASSISTANTS,
    type PreChatPriorAssistantItem,
} from "@/domains/onboarding/prechat-prior-assistants";
import { isElectron } from "@/runtime/is-electron";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";

interface PriorAssistantSelectionScreenProps {
  selectedAssistants: Set<string>;
  onChange: (next: Set<string>) => void;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

export function PriorAssistantSelectionScreen({
  selectedAssistants,
  onChange,
  onBack,
  onContinue,
  onSkip,
}: PriorAssistantSelectionScreenProps) {
  const electron = isElectron();

  const [otherText, setOtherText] = useState<string>(() =>
    deriveOtherText(selectedAssistants),
  );
  const [otherExpanded, setOtherExpanded] = useState<boolean>(
    () => otherText.length > 0,
  );

  const lastEmittedOtherSet = useRef<string>(setKeyForOtherEntries(selectedAssistants));
  useEffect(() => {
    const externalKey = setKeyForOtherEntries(selectedAssistants);
    if (externalKey === lastEmittedOtherSet.current) return;
    const seeded = deriveOtherText(selectedAssistants);
    setOtherText(seeded);
    setOtherExpanded((prev) => prev || seeded.length > 0);
    lastEmittedOtherSet.current = externalKey;
  }, [selectedAssistants]);

  useEffect(() => {
    const next = new Set<string>(
      [...selectedAssistants].filter((id) => !id.startsWith("other:")),
    );
    const seen = new Set<string>();
    for (const raw of otherText.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      next.add(`other:${trimmed}`);
    }
    if (!setsEqual(next, selectedAssistants)) {
      lastEmittedOtherSet.current = setKeyForOtherEntries(next);
      onChange(next);
    }
    // deps: selectedAssistants and onChange intentionally omitted — including selectedAssistants causes an update loop (effect → onChange → new selectedAssistants → effect)
  }, [otherText]);

  const toggleAssistant = (id: string): void => {
    const next = new Set(selectedAssistants);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  const otherEntries = useMemo<string[]>(() => {
    const seen = new Set<string>();
    return otherText
      .split(",")
      .map((s) => s.trim())
      .filter((s) => {
        if (!s) return false;
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
  }, [otherText]);

  const continueLabel =
    selectedAssistants.size === 0
      ? "Continue"
      : `Continue · ${selectedAssistants.size} selected`;

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className={`mx-auto flex w-full max-w-2xl flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}>
        <div
          className="grid w-full items-center grid-cols-[auto_1fr_auto]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h1 className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}>
            Have you used any of these?
          </h1>
          <div aria-hidden="true" className="h-8 w-8" />
        </div>
        <p
          className={`${electron ? "mt-3" : "mt-4"} text-center text-body-medium-lighter text-[var(--content-${electron ? "secondary" : "tertiary"})]`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          If you&apos;ve built anything with another assistant, I can help you
          bring it over.
        </p>

        <div
          className={`${electron ? "mt-4" : "mt-8"} grid w-full grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {PRECHAT_PRIOR_ASSISTANTS.map((assistant) => (
            <AssistantTile
              key={assistant.id}
              assistant={assistant}
              selected={selectedAssistants.has(assistant.id)}
              onToggle={() => toggleAssistant(assistant.id)}
            />
          ))}
          {otherExpanded ? null : (
            <OtherTile onClick={() => setOtherExpanded(true)} />
          )}
        </div>

        {otherExpanded ? (
          <Card
            padding="md"
            className="mt-3 w-full border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_8%,transparent)]"
          >
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Pencil
                  className="h-3.5 w-3.5 text-[var(--content-secondary)]"
                  aria-hidden="true"
                />
                <span className="text-body-medium-default prechat-md-regular text-[var(--content-default)]">
                  Something else
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOtherExpanded(false);
                    setOtherText("");
                  }}
                  aria-label="Dismiss custom assistants"
                  className="ml-auto inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-base)]"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <Input
                aria-label="Other assistants"
                placeholder="e.g. Perplexity, Poe, Character.AI..."
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                helperText="Separate multiple assistants with commas"
                fullWidth
              />
              {otherEntries.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {otherEntries.map((entry) => (
                    <span
                      key={entry}
                      className="rounded-full bg-[var(--primary-base)] px-3 py-1 text-label-small-default text-[var(--content-inset)]"
                    >
                      {entry}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        <div
          className={`${electron ? "mt-auto" : "mt-8"} flex w-full flex-col gap-2`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={selectedAssistants.size === 0}
            onClick={onContinue}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            {continueLabel}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            className={`${electron ? "h-9" : "h-11 text-base"}`}
          >
            I haven&apos;t used any
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function deriveOtherText(assistants: Set<string>): string {
  return [...assistants]
    .filter((id) => id.startsWith("other:"))
    .map((id) => id.slice(6))
    .sort()
    .join(", ");
}

function setKeyForOtherEntries(assistants: Set<string>): string {
  return [...assistants]
    .filter((id) => id.startsWith("other:"))
    .sort()
    .join("|");
}

function AssistantTile({
  assistant,
  selected,
  onToggle,
}: {
  assistant: PreChatPriorAssistantItem;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={assistant.label}
      className={`relative flex h-[88px] w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border p-2 transition-colors ${
        selected
          ? "border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_10%,transparent)]"
          : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
      }`}
    >
      <AssistantGlyph assistant={assistant} size={32} />
      <span className="line-clamp-2 text-center text-label-medium-default text-[var(--content-default)]">
        {assistant.label}
      </span>
      {selected ? (
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--primary-base)]"
        >
          <Check
            className="h-2.5 w-2.5 text-[var(--content-inset)]"
            aria-hidden="true"
          />
        </span>
      ) : null}
    </button>
  );
}

function OtherTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Something else"
      className="flex h-[88px] w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-2 transition-colors hover:bg-[var(--surface-base)]"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-base)]">
        <MoreHorizontal
          className="h-4 w-4 text-[var(--content-secondary)]"
          aria-hidden="true"
        />
      </span>
      <span className="line-clamp-2 text-center text-label-medium-default text-[var(--content-default)]">
        Something else
      </span>
    </button>
  );
}

function AssistantGlyph({
  assistant,
  size,
}: {
  assistant: PreChatPriorAssistantItem;
  size: number;
}) {
  if (assistant.logoSrc) {
    if (assistant.logoSrcDark) {
      return (
        <>
          <span className="flex items-center justify-center dark:hidden" style={{ width: size, height: size }} aria-hidden="true">
            <img
              src={assistant.logoSrc}
              alt=""
              width={size}
              height={size}
              className="max-h-full max-w-full object-contain"
              loading="eager"
            />
          </span>
          <span className="hidden items-center justify-center dark:flex" style={{ width: size, height: size }} aria-hidden="true">
            <img
              src={assistant.logoSrcDark}
              alt=""
              width={size}
              height={size}
              className="max-h-full max-w-full object-contain"
              loading="eager"
            />
          </span>
        </>
      );
    }
    return (
      <span className="flex items-center justify-center" style={{ width: size, height: size }}>
        <img
          src={assistant.logoSrc}
          alt=""
          width={size}
          height={size}
          className="max-h-full max-w-full object-contain"
          loading="eager"
        />
      </span>
    );
  }
  const initials = assistant.label.slice(0, 2).toUpperCase();
  return (
    <span
      className="flex items-center justify-center rounded-full bg-[var(--surface-base)] text-label-small-default text-[var(--content-default)]"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
