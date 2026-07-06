import { Check, ChevronLeft, MoreHorizontal, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
    PRECHAT_TOOLS,
    type PreChatToolItem,
} from "@/domains/onboarding/prechat-tools";
import { isElectron } from "@/runtime/is-electron";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";

import { MOBILE_INPUT_NO_ZOOM } from "@/domains/onboarding/onboarding-step-layout";

interface ToolSelectionScreenProps {
  selectedTools: Set<string>;
  onChange: (next: Set<string>) => void;
  onBack?: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

export function ToolSelectionScreen({
  selectedTools,
  onChange,
  onBack,
  onContinue,
  onSkip,
}: ToolSelectionScreenProps) {
  const electron = isElectron();

  const [otherText, setOtherText] = useState<string>(() =>
    deriveOtherText(selectedTools),
  );
  const [otherExpanded, setOtherExpanded] = useState<boolean>(
    () => otherText.length > 0,
  );

  const lastEmittedOtherSet = useRef<string>(setKeyForOtherEntries(selectedTools));
  useEffect(() => {
    const externalKey = setKeyForOtherEntries(selectedTools);
    if (externalKey === lastEmittedOtherSet.current) return;
    const seeded = deriveOtherText(selectedTools);
    setOtherText(seeded);
    setOtherExpanded((prev) => prev || seeded.length > 0);
    lastEmittedOtherSet.current = externalKey;
  }, [selectedTools]);

  useEffect(() => {
    const next = new Set<string>(
      [...selectedTools].filter((id) => !id.startsWith("other:")),
    );
    const seen = new Set<string>();
    for (const raw of otherText.split(",")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      next.add(`other:${trimmed}`);
    }
    if (!setsEqual(next, selectedTools)) {
      lastEmittedOtherSet.current = setKeyForOtherEntries(next);
      onChange(next);
    }
    // deps: selectedTools and onChange intentionally omitted — including selectedTools causes an update loop (effect → onChange → new selectedTools → effect)
  }, [otherText]);

  const toggleTool = (id: string): void => {
    const next = new Set(selectedTools);
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
    selectedTools.size === 0
      ? "Continue"
      : `Continue · ${selectedTools.size} selected`;

  return (
    <OnboardingLayout showCreatureFooter={false}>
      <div className={`mx-auto flex w-full max-w-2xl flex-col items-center ${electron ? "min-h-full px-8 pt-11 pb-8 electron-prechat-type" : "px-6 pt-12 pb-40"} text-[var(--content-default)]`}>
        <div
          className={`grid w-full items-center ${onBack ? "grid-cols-[auto_1fr_auto]" : ""}`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
        >
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-base)]"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : null}
          <h1 className={`text-center ${electron ? "text-title-large" : "text-3xl font-semibold tracking-tight"}`}>
            What do you use?
          </h1>
          {onBack ? <div aria-hidden="true" className="h-8 w-8" /> : null}
        </div>
        <p
          className={`${electron ? "mt-3" : "mt-4"} text-center text-body-medium-lighter text-[var(--content-${electron ? "secondary" : "tertiary"})]`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          This helps me tailor how I assist you. No connections needed — you
          can set those up later.
        </p>

        <div
          className={`grid w-full gap-2 ${electron ? "mt-4 grid-cols-4" : "mt-8 grid-cols-2 sm:grid-cols-3 md:grid-cols-4"}`}
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {PRECHAT_TOOLS.map((tool) => (
            <ToolTile
              key={tool.id}
              tool={tool}
              selected={selectedTools.has(tool.id)}
              onToggle={() => toggleTool(tool.id)}
              electron={electron}
            />
          ))}
          {otherExpanded ? null : (
            <OtherTile
              onClick={() => setOtherExpanded(true)}
              electron={electron}
            />
          )}
        </div>

        {otherExpanded ? (
          <Card
            padding={electron ? "sm" : "md"}
            className="mt-3 w-full border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_8%,transparent)]"
          >
            <div className={`flex flex-col ${electron ? "gap-2" : "gap-3"}`}>
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
                  aria-label="Dismiss custom tools"
                  className="ml-auto inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--content-tertiary)] hover:bg-[var(--surface-base)]"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <Input
                aria-label="Other tools"
                placeholder="e.g. Trello, Basecamp, Asana..."
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                helperText="Separate multiple tools with commas"
                className={MOBILE_INPUT_NO_ZOOM}
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
            disabled={selectedTools.size === 0}
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
            I&apos;ll set this up later
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

function deriveOtherText(tools: Set<string>): string {
  return [...tools]
    .filter((id) => id.startsWith("other:"))
    .map((id) => id.slice(6))
    .sort()
    .join(", ");
}

function setKeyForOtherEntries(tools: Set<string>): string {
  return [...tools]
    .filter((id) => id.startsWith("other:"))
    .sort()
    .join("|");
}

function ToolTile({
  tool,
  selected,
  onToggle,
  electron,
}: {
  tool: PreChatToolItem;
  selected: boolean;
  onToggle: () => void;
  electron: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={tool.label}
      className={`relative flex ${electron ? "h-[72px]" : "h-[88px]"} w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border p-2 transition-colors ${
        selected
          ? "border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_10%,transparent)]"
          : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
      }`}
    >
      <ToolGlyph tool={tool} size={32} />
      <span
        className={`${electron ? "w-full truncate" : "line-clamp-2"} text-center text-label-medium-default text-[var(--content-default)]`}
      >
        {tool.label}
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

function OtherTile({
  onClick,
  electron,
}: {
  onClick: () => void;
  electron: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Something else"
      className={`flex ${electron ? "min-h-[72px]" : "h-[88px]"} w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-2 transition-colors hover:bg-[var(--surface-base)]`}
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

function ToolGlyph({
  tool,
  size,
}: {
  tool: PreChatToolItem;
  size: number;
}) {
  if (tool.logoSrc) {
    if (tool.logoSrcDark) {
      return (
        <>
          <span className="flex items-center justify-center dark:hidden" style={{ width: size, height: size }} aria-hidden="true">
            <img
              src={tool.logoSrc}
              alt=""
              width={size}
              height={size}
              className="max-h-full max-w-full object-contain"
              loading="eager"
            />
          </span>
          <span className="hidden items-center justify-center dark:flex" style={{ width: size, height: size }} aria-hidden="true">
            <img
              src={tool.logoSrcDark}
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
          src={tool.logoSrc}
          alt=""
          width={size}
          height={size}
          className="max-h-full max-w-full object-contain"
          loading="eager"
        />
      </span>
    );
  }
  const initials = tool.label.slice(0, 2).toUpperCase();
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
