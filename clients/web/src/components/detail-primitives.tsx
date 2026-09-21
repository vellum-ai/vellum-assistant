/**
 * Small presentational primitives shared by side-drawer detail panels: the
 * block long content sits on, the `<pre>` code block built on it, the
 * monospace text every machine value is set in, and the uppercase section
 * label.
 *
 * Extracted from `tool-detail-panel.tsx` so tool-specific activity renderers
 * (`domains/chat/components/tool-activity/`) can compose them without importing
 * the panel that in turn imports those renderers. Every consumer imports them
 * from here.
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CardRoot,
  Typography,
  type TypographyAs,
} from "@vellumai/design-library";

import { CopyButton } from "@/components/copy-button";
import { useOverflows } from "@/hooks/use-overflows";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/**
 * Content taller than this folds behind "Show more". Roughly a dozen lines of
 * prose: enough to tell what a value holds, short enough that whatever sits
 * above it stays on screen.
 */
const CLAMP_HEIGHT = 260;

/**
 * Show more opens a folded value to at most this height, and it scrolls past
 * it: tall enough to read a good stretch at once, short enough that a
 * hundred-row table does not push the rest of the panel away.
 */
const EXPANDED_HEIGHT = 480;

/** The bottom of a clamped body fades to nothing over this height. */
const CLAMP_FADE = "3rem";

/**
 * The cut at the bottom of a clamped body: a mask rather than a painted
 * gradient, so the content itself fades out and the clamp reads the same on
 * whatever surface it sits on.
 */
const CLAMP_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${CLAMP_FADE}), transparent)`;

/**
 * Folds `children` behind a Show more control when they are taller than
 * {@link CLAMP_HEIGHT}, with a fade over the cut. The height is measured where
 * the content is drawn, at the width it is drawn at, so text of many short
 * lines folds as readily as one long paragraph, and content that fits never
 * offers to show more.
 *
 * Show more opens it to at most {@link EXPANDED_HEIGHT}, and the rest scrolls
 * inside the value, so a long value never runs a detail panel on, whatever it
 * is: a code block, a field's inline text, a table, a nested group.
 *
 * One fold per value: inside another fold, it draws its content as it is. A
 * group that folds would otherwise hide a folded field's own Show more under
 * its cut, and the field would take two to open.
 */
export function ClampedContent({
  label,
  children,
}: {
  /** Names the value while it scrolls; defaults to a generic name. */
  label?: string;
  children: ReactNode;
}) {
  if (useContext(InsideFold)) {
    return children;
  }
  return <Fold label={label}>{children}</Fold>;
}

/** Whether content is already inside a fold, which owns folding it. */
const InsideFold = createContext(false);

function Fold({
  label,
  children,
}: {
  label: string | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Measured against the fold height rather than the box, so the measure holds
  // while expanded too and content swapped in that fits drops the control.
  const fold = useOverflows<HTMLDivElement>({ limit: CLAMP_HEIGHT });
  // Against the box itself: whether the expanded value still has more below.
  const box = useOverflows<HTMLDivElement>();
  const measureFold = fold.ref;
  const measureBox = box.ref;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      measureFold(el);
      measureBox(el);
    },
    [measureFold, measureBox],
  );
  const toggle = () => {
    // Folding back shows the value from its start, not wherever it was
    // scrolled to while open.
    if (expanded && boxRef.current) {
      boxRef.current.scrollTop = 0;
    }
    setExpanded(!expanded);
  };
  const clamped = fold.overflows && !expanded;
  const scrolls = expanded && box.overflows;

  return (
    <>
      <div
        ref={ref}
        // A keyboard scrolls the expanded value only once it can focus it,
        // and anything focusable needs a role and a name (WCAG 2.1.1, 4.1.2).
        // The ring is inset: the box clips anything drawn outside it.
        role={scrolls ? "region" : undefined}
        aria-label={
          scrolls ? (label ?? t("detailPrimitives.expandedValue")) : undefined
        }
        tabIndex={scrolls ? 0 : undefined}
        className={cn(
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-inset keyboard-focus:ring-[var(--ring)]",
          expanded ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden",
        )}
        style={{
          maxHeight: expanded ? EXPANDED_HEIGHT : CLAMP_HEIGHT,
          ...(clamped && {
            maskImage: CLAMP_FADE_MASK,
            WebkitMaskImage: CLAMP_FADE_MASK,
          }),
        }}
      >
        {/* One child for the observer to follow as the content grows under
            the cap, which does not move the capped box itself. */}
        <div>
          <InsideFold value={true}>{children}</InsideFold>
        </div>
      </div>
      {fold.overflows && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="mt-2 w-full border-t border-[var(--border-base)] pt-2 text-left"
        >
          <Typography
            variant="body-medium-default"
            as="span"
            className="text-[var(--content-default)]"
          >
            {expanded
              ? t("detailPrimitives.showLess")
              : t("detailPrimitives.showMore")}
          </Typography>
        </button>
      )}
    </>
  );
}

interface DetailBlockProps {
  /** `outlined` carries a hairline border; `filled` is the bare surface. */
  variant?: "outlined" | "filled";
  /** Text the copy button copies. Without it the block has no copy button. */
  copyText?: string;
  /** Names the content while it scrolls, once opened past the fold. */
  label?: string;
  children: ReactNode;
}

/**
 * The surface long content sits on in a detail panel: clamped behind Show more
 * when it runs long, with a copy button in its top-right corner when there is
 * text to copy. It is a design-library `CardRoot` on the overlay surface, since the
 * panel it sits in is itself the lift surface a default card would take.
 *
 * It owns the conditions its parts depend on. The copy button is
 * absolutely positioned, so the block is its containing block, and it reserves
 * the button's room so it neither covers text nor overhangs the block: 24px on
 * the right on desktop, and where the button grows to a 40px touch target,
 * 40px on the right plus a height that holds it below its 8px inset.
 */
export function DetailBlock({
  variant = "outlined",
  copyText,
  label,
  children,
}: DetailBlockProps) {
  const { t } = useTranslation();
  const hasCopy = copyText !== undefined;

  return (
    <CardRoot
      surface="overlay"
      padding="sm"
      bordered={variant === "outlined"}
      className={cn(
        "relative",
        hasCopy && "pr-10 touch-mobile:min-h-14 touch-mobile:pr-14",
      )}
    >
      <ClampedContent label={label}>{children}</ClampedContent>
      {hasCopy && (
        <CopyButton
          text={copyText}
          ariaLabel={t("detailPrimitives.copy")}
          className="absolute right-2 top-2"
        />
      )}
    </CardRoot>
  );
}

const MACHINE_TEXT_TONE_CLASSES = {
  default: "text-[var(--content-default)]",
  muted: "text-[var(--content-tertiary)]",
  error: "text-[var(--system-negative-strong)]",
} as const;

type MachineTextTone = keyof typeof MACHINE_TEXT_TONE_CLASSES;

/** The type every machine value in a detail panel is set in, by tone. */
function machineTextClassName(tone: MachineTextTone): string {
  return cn("font-mono", MACHINE_TEXT_TONE_CLASSES[tone]);
}

interface MachineTextProps {
  as?: TypographyAs;
  tone?: MachineTextTone;
  /** Layout and wrapping for this spot, such as `truncate`. */
  className?: string;
  title?: string;
  children: ReactNode;
}

/**
 * Text a tool reads or writes: an argument, a path, a command, a tool id. It is
 * always monospace at the panel's code size, whether it sits inline or in a
 * {@link CodeBlock}, so a value reads the same wherever it appears and however
 * long it is. Whether it is shown inline or as a block is the caller's call.
 */
export function MachineText({
  as = "span",
  tone = "default",
  className,
  title,
  children,
}: MachineTextProps) {
  return (
    <Typography
      variant="body-small-lighter"
      as={as}
      title={title}
      className={cn(machineTextClassName(tone), className)}
    >
      {children}
    </Typography>
  );
}

/**
 * Preformatted machine text: line breaks and spacing kept, long lines wrapped.
 * The body of a {@link CodeBlock}, and of any block that frames its own.
 */
export function CodePre({
  text,
  tone = "default",
}: {
  text: string;
  tone?: Exclude<MachineTextTone, "muted">;
}) {
  return (
    <Typography
      variant="body-small-lighter"
      asChild
      className={cn(
        machineTextClassName(tone),
        "whitespace-pre-wrap break-words",
      )}
    >
      <pre>{text}</pre>
    </Typography>
  );
}

/**
 * A `<pre>` code block with a copy button positioned in the top-right, clamped
 * when the text is long. Tool results reach the panel at up to
 * `HARD_MAX_TOOL_RESULT_CHARS` (400,000), which is not a height any panel can
 * absorb.
 */
export function CodeBlock({
  text,
  tone = "default",
  label,
}: {
  text: string;
  /** `error` tints the text, so a failed result reads as one at a glance. */
  tone?: "default" | "error";
  /** Names the block while it scrolls, once opened past the fold. */
  label?: string;
}) {
  return (
    <DetailBlock copyText={text} label={label}>
      <CodePre text={text} tone={tone} />
    </DetailBlock>
  );
}

/**
 * Uppercase section label in `--content-tertiary`.
 *
 * `leading-4` is deliberate: the `label-small-default` token ships
 * `line-height: 1`, which leaves no room below the baseline and clips glyph
 * tails. Size is unchanged.
 */
export function SectionLabel({
  children,
  className = "mb-2",
}: {
  children: string;
  /** Margin override for rows that manage their own spacing. */
  className?: string;
}) {
  return (
    <Typography
      variant="label-small-default"
      as="div"
      className={`uppercase leading-4 tracking-wider text-[var(--content-tertiary)] ${className}`}
    >
      {children}
    </Typography>
  );
}
