
import { Check, ChevronLeft, MoreHorizontal, Pencil, X } from "lucide-react";
import { AppImage } from "@/adapters/app-image.js";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Input } from "@vellum/design-library/components/input";
import { OnboardingLayout } from "@/components/app/onboarding/OnboardingLayout.js";
import {
  PRECHAT_TOOLS,
  type PreChatToolItem,
} from "@/lib/onboarding/prechat-tools.js";

/**
 * First of the three PreChat onboarding screens. Mirrors the macOS
 * `ToolSelectionView` (4-column tool grid with selection state, an inline
 * "Something else" expander, and a primary/skip footer).
 *
 * Custom tools typed into the expander land in `selectedTools` as
 * `other:<entry>` IDs. The page-level orchestrator strips the prefix via
 * `stripOtherPrefix` before serializing the wire payload.
 */
interface ToolSelectionScreenProps {
  selectedTools: Set<string>;
  onChange: (next: Set<string>) => void;
  /** When provided, renders a back chevron in the header. */
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
  // `otherText` is local to this screen — the parent only sees the
  // normalized `other:<entry>` IDs in `selectedTools`. Seed from the
  // current `other:*` entries with `useState`'s lazy initializer so the
  // expander preserves typed values across back-nav remounts.
  const [otherText, setOtherText] = useState<string>(() =>
    deriveOtherText(selectedTools),
  );
  const [otherExpanded, setOtherExpanded] = useState<boolean>(
    () => otherText.length > 0,
  );

  // External-sync guard: if the parent rebuilds `selectedTools` with an
  // `other:*` set the user did NOT just type into the input (e.g. the
  // parent restored persisted state, or another screen mutated the set),
  // re-seed the input from the new prop. We track the last set we
  // produced ourselves via a ref so user keystrokes don't fight the
  // sync.
  const lastEmittedOtherSet = useRef<string>(setKeyForOtherEntries(selectedTools));
  useEffect(() => {
    const externalKey = setKeyForOtherEntries(selectedTools);
    if (externalKey === lastEmittedOtherSet.current) return;
    // External change — re-seed local input + expander.
    const seeded = deriveOtherText(selectedTools);
    setOtherText(seeded);
    setOtherExpanded((prev) => prev || seeded.length > 0);
    lastEmittedOtherSet.current = externalKey;
  }, [selectedTools]);

  // Sync the parent's `selectedTools` with the comma-separated
  // `otherText` whenever the user types. Splitting/dedupe lives here so
  // the parent only ever sees normalized `other:<entry>` IDs.
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
    // We intentionally only re-run when the user types. Toggling tiles
    // already calls onChange directly with the right set.
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
    <OnboardingLayout>
      {/*
        `pb-40` reserves clearance above OnboardingLayout's absolute
        CreatureFooter (overflow-hidden parent + ~180px footer art) so
        the primary CTA stays visible above the creature illustration on
        short viewports. Matches the pattern in NameExchangeScreen.
      */}
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pb-40 pt-12 text-[var(--content-default)]">
        {/* Header row: optional back chevron in the leading column, centered title */}
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
          {/* typography: off-scale — hero onboarding h1 (30px) intentionally larger than text-title-large (24px) to match macOS onboarding visual weight */}
          { }
          <h1 className="text-center text-3xl font-semibold tracking-tight">
            What do you use?
          </h1>
          {onBack ? <div aria-hidden="true" className="h-8 w-8" /> : null}
        </div>
        <p
          className="mt-4 text-center text-body-medium-lighter text-[var(--content-tertiary)]"
          style={{ animation: "fadeInUp 0.3s ease-out 0.15s both" }}
        >
          This helps me tailor how I assist you. No connections needed — you
          can set those up later.
        </p>

        <div
          className="mt-8 grid w-full grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
          style={{ animation: "fadeInUp 0.3s ease-out 0.2s both" }}
        >
          {PRECHAT_TOOLS.map((tool) => (
            <ToolTile
              key={tool.id}
              tool={tool}
              selected={selectedTools.has(tool.id)}
              onToggle={() => toggleTool(tool.id)}
            />
          ))}
          {/*
            macOS parity: when the user opens the "Something else"
            expander, the tile is REPLACED by the input card below the
            grid — not duplicated. Hide the tile while expanded.
          */}
          {otherExpanded ? null : (
            <OtherTile onClick={() => setOtherExpanded(true)} />
          )}
        </div>

        {otherExpanded ? (
          <Card
            padding="md"
            // Highlighted border + tinted background match the macOS
            // expanded "Something else" card: it's the active selection,
            // so it should look like the selected-tile state.
            className="mt-3 w-full border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_8%,transparent)]"
          >
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Pencil
                  className="h-3.5 w-3.5 text-[var(--content-secondary)]"
                  aria-hidden="true"
                />
                <span className="text-body-medium-default text-[var(--content-default)]">
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
          className="mt-8 flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.3s ease-out 0.3s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={selectedTools.size === 0}
            onClick={onContinue}
            // typography: off-scale — CTA upsize; Button primitive only exposes regular/compact so text-base forces the spec's 16px "lg" size
             
            className="h-11 text-base"
          >
            {continueLabel}
          </Button>
          <Button
            variant="ghost"
            size="regular"
            fullWidth
            onClick={onSkip}
            // typography: off-scale — CTA upsize paired with the Continue button above
             
            className="h-11 text-base"
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

/**
 * Comma-separated string built from any `other:<entry>` IDs in the
 * provided tool set. Used both to seed the inline input on mount and to
 * re-seed it when the parent rebuilds `selectedTools` externally.
 */
function deriveOtherText(tools: Set<string>): string {
  return [...tools]
    .filter((id) => id.startsWith("other:"))
    .map((id) => id.slice(6))
    .sort()
    .join(", ");
}

/**
 * Stable key for the `other:*` subset of a tool set. Comparing keys
 * lets the external-sync effect detect when a re-emit came from this
 * component vs. from the parent, so user keystrokes don't fight the
 * sync.
 */
function setKeyForOtherEntries(tools: Set<string>): string {
  return [...tools]
    .filter((id) => id.startsWith("other:"))
    .sort()
    .join("|");
}

/**
 * Single tile in the tool grid. Renders the tool's logo (or initials
 * fallback) and a check badge when selected.
 */
function ToolTile({
  tool,
  selected,
  onToggle,
}: {
  tool: PreChatToolItem;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      aria-label={tool.label}
      className={`relative flex h-[88px] w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border p-2 transition-colors ${
        selected
          ? "border-[var(--primary-base)] bg-[color-mix(in_srgb,var(--primary-base)_10%,transparent)]"
          : "border-[var(--border-element)] bg-[var(--surface-lift)] hover:bg-[var(--surface-base)]"
      }`}
    >
      <ToolGlyph tool={tool} size={32} />
      <span className="line-clamp-2 text-center text-label-medium-default text-[var(--content-default)]">
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

/**
 * 13th tile that opens the inline "Something else" expander when clicked.
 * Caller hides this tile while the expander is open (macOS parity).
 */
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

/**
 * Renders the tool's logo via `next/image`, or a 2-character initials
 * fallback in a circle when the tool has no asset (e.g. apple-notes).
 */
function ToolGlyph({
  tool,
  size,
}: {
  tool: PreChatToolItem;
  size: number;
}) {
  if (tool.logoSrc) {
    // When a `logoSrcDark` variant is supplied, render BOTH images and
    // toggle visibility via Tailwind's class-based `dark:` variant. The
    // app uses a `.dark` class on the root (not `prefers-color-scheme`),
    // so the SVG itself can't decide via media query — has to be done
    // in CSS up the tree. Both files are tiny so the dual-fetch is
    // acceptable; the hidden one is `display: none`, not just opacity.
    if (tool.logoSrcDark) {
      return (
        <>
          <span className="flex items-center justify-center dark:hidden" style={{ width: size, height: size }} aria-hidden="true">
            <AppImage
              src={tool.logoSrc}
              alt=""
              width={size}
              height={size}
              className="max-h-full max-w-full object-contain"
              loading="eager"
              unoptimized
            />
          </span>
          <span className="hidden items-center justify-center dark:flex" style={{ width: size, height: size }} aria-hidden="true">
            <AppImage
              src={tool.logoSrcDark}
              alt=""
              width={size}
              height={size}
              className="max-h-full max-w-full object-contain"
              loading="eager"
              unoptimized
            />
          </span>
        </>
      );
    }
    return (
      <span className="flex items-center justify-center" style={{ width: size, height: size }}>
        <AppImage
          src={tool.logoSrc}
          alt=""
          width={size}
          height={size}
          className="max-h-full max-w-full object-contain"
          loading="eager"
          unoptimized
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
