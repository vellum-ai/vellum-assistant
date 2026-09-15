/**
 * The popover beside the companion: what the assistant needs the user to see
 * or answer while they talk to it away from the app's window.
 *
 * - The approvals the turn is waiting on: one is asked in a row with Allow and
 *   Deny; several are summed up ("Need your OK on 3 things") and listed,
 *   numbered, once the user asks to review them.
 * - A credential: a row naming the service, then a form once the user asks to
 *   enter it.
 * - A card with an image or a link, or a surface the popover cannot draw,
 *   named with a way into the app.
 * - A picker the call bar opened: the microphone, or the assistant's voice.
 *
 * {@link CompanionPromptRow} is the short form on its own, which a call's bar
 * also carries as a row of its own. Presentational: the pages own the windows,
 * the state and the presses, so everything here renders in Storybook and
 * tests as it is.
 */

import { KeyRound, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { defaultUrlTransform } from "react-markdown";

import type {
  CompanionApproval,
  CompanionPopover as CompanionPopoverContent,
  CompanionPopoverAction,
  CompanionPopoverAnswer,
  CompanionPopoverView,
} from "@vellumai/ipc-contract";
import { COMPANION_POPOVER_SECRET_MAX } from "@vellumai/ipc-contract";
import {
  MarkdownMessage,
  type MarkdownImageComponent,
  type MarkdownLinkComponent,
} from "@vellumai/design-library";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";

import {
  MicrophonePicker,
  VoicePicker,
} from "@/components/companion-popover-pickers";
import {
  hasBundledIntegrationLogo,
  IntegrationIcon,
} from "@/components/integrations/integration-icon";
import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

/** A popover with a short form: the approvals, or a credential. */
export type CompanionPromptContent = Extract<
  CompanionPopoverContent,
  { kind: "approvals" | "secret" }
>;

export interface CompanionPopoverProps {
  popover: CompanionPopoverContent;
  /** How the popover is shown. A card or a surface is always drawn whole. */
  view: CompanionPopoverView;
  /** The card's element, for the page to measure. */
  cardRef?: Ref<HTMLDivElement>;
  /** Absent leaves the presses inert, which is what Storybook wants. */
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onView?: (view: CompanionPopoverView) => void;
  onOpenLink?: (url: string) => void;
  /**
   * The assistant's colour, which faintly tints the ground of a popover drawn
   * whole. Absent draws it neutral.
   */
  accentHex?: string;
  /**
   * Drawn on a call's bar, which supplies the ground, the edge and the
   * light: the popover draws its content and nothing around it.
   */
  attached?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Whether an image source is one the popover draws: the web, or inline. */
export const drawsImageSource = (src: string): boolean =>
  /^https?:\/\//i.test(src) || /^data:image\//i.test(src);

/** The dark ground a prompt's row is drawn on, the call bar's own. */
export const COMPANION_POPOVER_SURFACE_CLASS =
  "border border-white/5 bg-[var(--surface-base)] text-[var(--content-default)] shadow-lg shadow-black/40";

/**
 * The ground of a popover drawn whole: the call bar's own dark, so the panel
 * and the bar beneath it read as one material, with a faint wash of the
 * assistant's colour from the top corner.
 *
 * A wash rather than a blur of what is behind it. The popover is a window of
 * its own over another application, and a page cannot see what another
 * window draws. Kept faint: a stronger tint turns a warm accent muddy against
 * the neutral bar.
 */
const panelBackground = (accentHex: string | undefined): string => {
  const wash =
    accentHex === undefined
      ? "transparent"
      : `color-mix(in srgb, ${accentHex} 7%, transparent)`;
  return `radial-gradient(120% 80% at 0% 0%, ${wash} 0%, transparent 70%), #17181b`;
};

export function CompanionPopover({
  popover,
  view,
  cardRef,
  onAnswer,
  onView,
  onOpenLink,
  accentHex,
  attached = false,
  className,
  style,
}: CompanionPopoverProps) {
  const { t } = useTranslation();
  if (
    (popover.kind === "approvals" || popover.kind === "secret") &&
    view !== "expanded"
  ) {
    return (
      <div
        ref={cardRef}
        role="group"
        data-companion-popover={popover.kind}
        className={cn(
          // As wide as its words up to a cap, then wrapped: an ask cut short
          // is one the user cannot judge. The radius is half a single row
          // tall, so one line still reads as a pill.
          "w-max max-w-[640px] rounded-[22px]",
          COMPANION_POPOVER_SURFACE_CLASS,
          className,
        )}
        style={style}
      >
        <CompanionPromptRow
          popover={popover}
          onAnswer={onAnswer}
          onView={onView}
        />
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      // A group rather than a dialog: every answer is the pointer's, and the
      // one form on it takes the keyboard only while it is up.
      role="group"
      data-companion-popover={popover.kind}
      className={cn(
        // A column the page bounds in height: a header and a row of answers
        // that stay put, and the content between them scrolling, so the
        // answers are always within reach however long the content runs.
        "flex min-h-0 flex-col gap-3 p-4 text-[var(--content-default)]",
        !attached &&
          "rounded-[20px] border border-white/10 shadow-2xl shadow-black/50",
        popover.kind === "approvals" ? "w-max max-w-[640px]" : "w-[360px]",
        // A picker's rows run to the panel's edges rather than its padding.
        (popover.kind === "microphones" || popover.kind === "voices") &&
          "gap-2 px-4 pb-3",
        className,
      )}
      style={
        attached ? style : { background: panelBackground(accentHex), ...style }
      }
    >
      {popover.kind === "approvals" ? (
        <>
          <PopoverHeader
            title={t("companionPopover.needsOkCount", {
              count: popover.items.length,
            })}
            onClose={() => onView?.("deferred")}
          />
          <ApprovalList items={popover.items} onAnswer={onAnswer} />
        </>
      ) : popover.kind === "secret" ? (
        <SecretForm popover={popover} onAnswer={onAnswer} onView={onView} />
      ) : popover.kind === "microphones" ? (
        <>
          <PopoverHeader
            title={t("companionPopover.microphoneTitle")}
            onClose={() => onAnswer?.({ kind: "dismiss" })}
          />
          <MicrophonePicker popover={popover} onAnswer={onAnswer} />
        </>
      ) : popover.kind === "voices" ? (
        <>
          <PopoverHeader
            title={t("companionPopover.voiceTitle")}
            onClose={() => onAnswer?.({ kind: "dismiss" })}
          />
          <VoicePicker popover={popover} onAnswer={onAnswer} />
        </>
      ) : (
        <SurfaceCard
          popover={popover}
          onAnswer={onAnswer}
          onOpenLink={onOpenLink}
        />
      )}
    </div>
  );
}

/**
 * The short form of a prompt, as one row: its words and its answers. Drawn in
 * a pill beside the creature, or as a row of a call's bar.
 */
export function CompanionPromptRow({
  popover,
  onAnswer,
  onView,
  className,
}: {
  popover: CompanionPromptContent;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onView?: (view: CompanionPopoverView) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const first = popover.kind === "approvals" ? popover.items[0] : undefined;
  const single = popover.kind === "approvals" && popover.items.length === 1;

  return (
    <div
      data-companion-prompt-row={popover.kind}
      className={cn(
        "flex min-h-11 min-w-0 items-center gap-1.5 py-1.5 pr-1.5 text-[var(--content-default)]",
        popover.kind === "secret" ? "pl-2" : "pl-4",
        className,
      )}
    >
      {popover.kind === "secret" ? (
        <ServiceIcon providerKey={popover.providerKey} />
      ) : null}
      <StepText
        className="min-w-0 flex-1 text-body-medium-default"
        maxWidth={PROMPT_TEXT_MAX_WIDTH}
        text={
          popover.kind === "secret"
            ? popover.service !== ""
              ? t("companionPopover.needsCredentialsFor", {
                  service: popover.service,
                })
              : t("companionPopover.needsCredentials")
            : single && first !== undefined
              ? first.title
              : t("companionPopover.needsOkCount", {
                  count: popover.items.length,
                })
        }
      />
      <span className="ml-2 flex shrink-0 items-center gap-1">
        {single && first !== undefined ? (
          <ApprovalAnswers item={first} pill onAnswer={onAnswer} />
        ) : (
          <>
            <PillButton tone="secondary" onClick={() => onView?.("deferred")}>
              {t("companionPopover.notNow")}
            </PillButton>
            <PillButton tone="primary" onClick={() => onView?.("expanded")}>
              {popover.kind === "secret"
                ? t("companionPopover.enter")
                : t("companionPopover.review")}
            </PillButton>
          </>
        )}
      </span>
    </div>
  );
}

/** The widest a prompt row's words run before they wrap, in points. */
const PROMPT_TEXT_MAX_WIDTH = 440;
/** The same, for a row of the numbered list, which carries a number too. */
const LIST_TEXT_MAX_WIDTH = 400;

/**
 * Where to break words into lines so that no line is wider than the one
 * below it, within `maxWidth`, with the lines as even as that allows.
 *
 * As few lines as the rule allows: the lines the words need at `maxWidth`,
 * or more when no split of that many steps outward. Among the ways to split
 * the words into that many lines where each line is no wider than the next
 * and the last fits, the one whose lines fall least short of the last line's
 * width wins, so the text reads as one block stepping gently outward rather
 * than a word left alone on top. A single word wider than the width stands
 * on a line of its own. Past {@link STEP_LINES_MAX_WORDS} words the ordinary
 * wrap is kept, since the search grows with the cube of the words.
 *
 * Pure, with the measure passed in, so it is stated in tests without fonts.
 */
export function stepLines(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string[] {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  const n = words.length;
  if (n < 2 || measure(words.join(" ")) <= maxWidth) {
    return [words.join(" ")];
  }
  // widths[i][j]: words i up to (not including) j on one line.
  const widths: number[][] = words.map(() => []);
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j <= n; j += 1) {
      widths[i][j] = measure(words.slice(i, j).join(" "));
    }
  }
  const lineOf = (from: number, to: number): string =>
    words.slice(from, to).join(" ");

  // The ordinary wrap at the full width, and how many lines it takes.
  const ordinary: string[] = [];
  for (let from = 0; from < n; ) {
    let to = from + 1;
    while (to < n && widths[from][to + 1] <= maxWidth) {
      to += 1;
    }
    ordinary.push(lineOf(from, to));
    from = to;
  }
  if (ordinary.length < 2 || n > STEP_LINES_MAX_WORDS) {
    return ordinary;
  }

  /**
   * The evenest split into exactly `count` lines where each line is no wider
   * than the next and the last fits, or null when there is none.
   */
  const evenest = (count: number): string[] | null => {
    let best: { cost: number; breaks: number[] } | null = null;
    // The last line first: its width is the one every other line steps up to.
    for (let lastStart = n - 1; lastStart >= count - 1; lastStart -= 1) {
      const last = widths[lastStart][n];
      if (last > maxWidth && lastStart !== n - 1) {
        continue;
      }
      // Keyed `end:start`: the best lines over words [0, end) whose last line
      // is [start, end), with the starts of those lines in `breaks`.
      let layer = new Map<string, { cost: number; breaks: number[] }>();
      for (let end = 1; end <= lastStart; end += 1) {
        if (widths[0][end] <= last) {
          layer.set(`${end}:0`, {
            cost: (last - widths[0][end]) ** 2,
            breaks: [0],
          });
        }
      }
      for (let k = 2; k <= count - 1; k += 1) {
        const next = new Map<string, { cost: number; breaks: number[] }>();
        for (const [key, entry] of layer) {
          const [end, start] = key.split(":").map(Number);
          const width = widths[start][end];
          for (let to = end + 1; to <= lastStart; to += 1) {
            const nextWidth = widths[end][to];
            if (nextWidth < width || nextWidth > last) {
              continue;
            }
            const cost = entry.cost + (last - nextWidth) ** 2;
            const nextKey = `${to}:${end}`;
            const held = next.get(nextKey);
            if (held === undefined || cost < held.cost) {
              next.set(nextKey, { cost, breaks: [...entry.breaks, end] });
            }
          }
        }
        layer = next;
      }
      for (const [key, entry] of layer) {
        const [end, start] = key.split(":").map(Number);
        if (end !== lastStart || widths[start][end] > last) {
          continue;
        }
        if (best === null || entry.cost < best.cost) {
          best = { cost: entry.cost, breaks: [...entry.breaks, lastStart] };
        }
      }
    }
    if (best === null) {
      return null;
    }
    const bounds = [...best.breaks, n];
    return best.breaks.map((from, index) => lineOf(from, bounds[index + 1]));
  };

  // The fewest lines the rule allows: the ordinary count when some split of
  // it steps outward, otherwise one more line at a time. The rule outranks
  // the count, since a wider top line is the thing being avoided.
  for (let count = ordinary.length; count <= n; count += 1) {
    const lines = evenest(count);
    if (lines !== null) {
      return lines;
    }
  }
  return ordinary;
}

/** The most words {@link stepLines} searches over. */
const STEP_LINES_MAX_WORDS = 48;

/**
 * Words that wrap as {@link stepLines} breaks them, each line drawn on its
 * own so the page cannot break them anywhere else. Drawn as plain text until
 * the font can be measured, and wherever it cannot be.
 */
function StepText({
  text,
  maxWidth,
  className,
  title,
}: {
  text: string;
  maxWidth: number;
  className?: string;
  title?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [lines, setLines] = useState<string[] | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    let cancelled = false;
    const measureLines = (): void => {
      if (cancelled) {
        return;
      }
      // Measured in the page, in the element's own face, rather than on a
      // canvas: the canvas resolves the font on its own and can differ from
      // what is drawn by enough to pick breaks that step the wrong way.
      const probe = document.createElement("span");
      probe.style.cssText =
        "position:absolute;visibility:hidden;white-space:pre;left:0;top:0";
      element.appendChild(probe);
      const widths = new Map<string, number>();
      const measured = stepLines(text, maxWidth, (words) => {
        const known = widths.get(words);
        if (known !== undefined) {
          return known;
        }
        probe.textContent = words;
        const width = probe.getBoundingClientRect().width;
        widths.set(words, width);
        return width;
      });
      probe.remove();
      setLines(measured.length > 1 ? measured : null);
    };
    measureLines();
    // Measured again as faces finish loading, since a fallback font's widths
    // put the breaks somewhere else.
    document.fonts?.addEventListener("loadingdone", measureLines);
    void document.fonts?.ready.then(measureLines);
    return () => {
      cancelled = true;
      document.fonts?.removeEventListener("loadingdone", measureLines);
    };
  }, [text, maxWidth]);

  return (
    <span ref={ref} dir="auto" className={className} title={title}>
      {lines === null
        ? text
        : lines.map((line, index) => (
            <span key={index} className="block whitespace-nowrap">
              {line}
              {index < lines.length - 1 ? " " : null}
            </span>
          ))}
    </span>
  );
}

/**
 * An approval's two answers, dismissive then primary so Allow is rightmost:
 * as pills in a prompt's row, and as the design library's own buttons in a
 * panel.
 */
function ApprovalAnswers({
  item,
  pill,
  onAnswer,
}: {
  item: CompanionApproval;
  pill: boolean;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
}) {
  const { t } = useTranslation();
  const deny = (): void => onAnswer?.({ kind: "deny", itemId: item.id });
  const allow = (): void =>
    onAnswer?.({
      // A permission request's allow opens the pane it asks for too.
      kind: item.permission === undefined ? "allow" : "settings",
      itemId: item.id,
    });
  if (!pill) {
    return (
      <>
        <Button variant="dangerOutline" onClick={deny}>
          {t("companionPopover.deny")}
        </Button>
        <Button variant="primary" onClick={allow}>
          {t("companionPopover.allow")}
        </Button>
      </>
    );
  }
  return (
    <>
      <PillButton tone="negative" onClick={deny}>
        {t("companionPopover.deny")}
      </PillButton>
      <PillButton tone="primary" onClick={allow}>
        {t("companionPopover.allow")}
      </PillButton>
    </>
  );
}

/**
 * A panel's header: its title, and the close at the far end. What closing
 * means is the caller's: putting a prompt off, or dismissing a card.
 */
function PopoverHeader({
  title,
  icon,
  emphasis = false,
  onClose,
}: {
  title: string;
  icon?: ReactNode;
  /** The title is the content's own (a card's), rather than a label for it. */
  emphasis?: boolean;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="-mt-0.5 -mr-1.5 flex min-h-7 items-center gap-2">
      {icon}
      <p
        dir="auto"
        className={cn(
          "min-w-0 flex-1",
          emphasis
            ? "text-title-small leading-snug"
            : "text-body-small-default text-[var(--content-tertiary)] select-none",
        )}
      >
        {title}
      </p>
      <Button
        variant="ghost"
        className="size-7 rounded-lg px-0"
        aria-label={t("companionPopover.dismiss")}
        iconOnly={<X className="size-4" strokeWidth={2} />}
        onClick={onClose}
      />
    </div>
  );
}

/** Every pending approval, numbered, each answered on its own row. */
function ApprovalList({
  items,
  onAnswer,
}: {
  items: readonly CompanionApproval[];
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
}) {
  return (
    <ScrollShadow
      className="min-h-0 flex-1"
      size={20}
      fadeEdges="end"
      hideScrollBar
    >
      <ol className="flex flex-col gap-2">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-lift)] text-body-medium-default text-[var(--content-tertiary)]"
            >
              {index + 1}
            </span>
            <StepText
              className="min-w-0 flex-1 pl-1 text-body-medium-default"
              maxWidth={LIST_TEXT_MAX_WIDTH}
              title={item.detail !== "" ? item.detail : undefined}
              text={item.title}
            />
            <span className="ml-2 flex shrink-0 items-center gap-2">
              <ApprovalAnswers item={item} pill={false} onAnswer={onAnswer} />
            </span>
          </li>
        ))}
      </ol>
    </ScrollShadow>
  );
}

/** The credential form: which service, why, the field, and the two answers. */
function SecretForm({
  popover,
  onAnswer,
  onView,
}: {
  popover: Extract<CompanionPopoverContent, { kind: "secret" }>;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onView?: (view: CompanionPopoverView) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focused on arrival, and again each time the window is lent the keyboard:
  // becoming key hands focus to whatever the window focused last, which is
  // not the field, so a focus taken on arrival alone does not hold.
  useEffect(() => {
    const focusField = (): void => {
      inputRef.current?.focus();
    };
    focusField();
    window.addEventListener("focus", focusField);
    return () => {
      window.removeEventListener("focus", focusField);
    };
  }, []);

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") {
          onAnswer?.({ kind: "secret", value });
        }
      }}
    >
      <PopoverHeader
        icon={<ServiceIcon providerKey={popover.providerKey} />}
        title={
          popover.service !== ""
            ? t("companionPopover.needsCredentialsFor", {
                service: popover.service,
              })
            : t("companionPopover.needsCredentials")
        }
        onClose={() => onView?.("deferred")}
      />
      <ScrollShadow
        className="min-h-0 flex-1"
        size={20}
        fadeEdges="end"
        hideScrollBar
      >
        <div className="flex flex-col gap-3">
          {popover.detail !== "" ? (
            <p
              dir="auto"
              className="text-body-medium-lighter text-[var(--content-secondary)]"
            >
              {popover.detail}
            </p>
          ) : null}
          <Input
            ref={inputRef}
            type="password"
            fullWidth
            autoComplete="off"
            // The surfaces around it turn selection off, and a field that
            // inherits that will not take a caret where it is clicked.
            className="select-text"
            maxLength={COMPANION_POPOVER_SECRET_MAX}
            label={
              popover.label !== ""
                ? popover.label
                : t("companionPopover.credentialLabel")
            }
            placeholder={popover.placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
        </div>
      </ScrollShadow>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button variant="outlined" onClick={() => onView?.("deferred")}>
          {t("companionPopover.notNow")}
        </Button>
        <Button variant="primary" type="submit" disabled={value === ""}>
          {t("companionPopover.confirm")}
        </Button>
      </div>
    </form>
  );
}

/** A card in full, or a surface the popover can only name. */
function SurfaceCard({
  popover,
  onAnswer,
  onOpenLink,
}: {
  popover: Extract<CompanionPopoverContent, { kind: "card" | "surface" }>;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onOpenLink?: (url: string) => void;
}) {
  const { t } = useTranslation();
  // A pressed action is on its way: the rest wait for the answer, so a
  // double press cannot send the same action twice. The page remounts this
  // for each popover, which is what clears it.
  const [pressed, setPressed] = useState(false);
  return (
    <>
      {/* The card's own title heads it, beside the close. Whose card it is
          needs no saying: the creature is right beside it. */}
      <PopoverHeader
        emphasis
        title={
          popover.title !== ""
            ? popover.title
            : popover.kind === "surface"
              ? t("companionPopover.surfaceFallback")
              : ""
        }
        onClose={() => onAnswer?.({ kind: "dismiss" })}
      />
      {popover.kind === "card" ? (
        <>
          {/* Under the title and outside the scrolling content, so it stays
              with the title it qualifies. */}
          {popover.subtitle !== "" ? (
            <p
              dir="auto"
              className="-mt-2.5 text-body-medium-lighter text-[var(--content-tertiary)]"
            >
              {popover.subtitle}
            </p>
          ) : null}
          <ScrollShadow
            className="min-h-0 flex-1"
            size={20}
            fadeEdges="end"
            hideScrollBar
          >
            <div className="flex flex-col gap-3">
              {popover.body !== "" ? (
                <CardBody body={popover.body} onOpenLink={onOpenLink} />
              ) : null}
            </div>
          </ScrollShadow>
          {popover.actions.length > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              {actionsInOrder(popover.actions).map((action) => (
                <Button
                  key={action.id}
                  variant={variantForAction(action)}
                  disabled={pressed}
                  onClick={() => {
                    setPressed(true);
                    onAnswer?.({ kind: "action", actionId: action.id });
                  }}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex items-center justify-end">
            <Button
              variant="primary"
              onClick={() => onAnswer?.({ kind: "open" })}
            >
              {t("companionPopover.openApp")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The card's markdown. Links open in the browser through main, since the
 * window denies navigation; images draw only from the web or inline data,
 * since workspace files need the app's session to fetch.
 */
function CardBody({
  body,
  onOpenLink,
}: {
  body: string;
  onOpenLink?: (url: string) => void;
}) {
  const link: MarkdownLinkComponent = useCallback(
    ({ href, children }) => (
      <a
        href={href}
        className="text-[var(--content-default)] underline decoration-[var(--content-tertiary)] underline-offset-2 hover:decoration-[var(--content-default)]"
        onClick={(event) => {
          event.preventDefault();
          if (href !== undefined) {
            onOpenLink?.(href);
          }
        }}
      >
        {children}
      </a>
    ),
    [onOpenLink],
  );
  return (
    <MarkdownMessage
      content={body}
      // The chat's spacing is sized for a transcript, a line's height between
      // paragraphs. A card this size wants a third of that, and lists that
      // sit in the text rather than out from it.
      className="text-body-medium-lighter text-[var(--content-secondary)] [&_li]:mb-1 [&_ol]:mb-2 [&_ol]:pl-4 [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:pl-4"
      linkComponent={link}
      imageComponent={PopoverImage}
      urlTransform={popoverUrlTransform}
    />
  );
}

/**
 * Markdown's own URL sanitising, which drops `data:` URLs, with inline images
 * let through for the image component to draw.
 */
const popoverUrlTransform = (url: string): string =>
  /^data:image\//i.test(url) ? url : defaultUrlTransform(url);

const PopoverImage: MarkdownImageComponent = ({ src, alt }) =>
  drawsImageSource(src) ? (
    <img
      src={src}
      alt={alt}
      draggable={false}
      className="my-1 max-h-60 w-full rounded-xl object-contain"
    />
  ) : null;

/**
 * What stands beside a credential's words: the service's logo when one ships
 * for it, and otherwise a key. Never the initials avatar a logo falls back
 * to, which beside "Need credentials" reads as a person rather than a
 * service.
 */
function ServiceIcon({ providerKey }: { providerKey?: string }) {
  if (providerKey !== undefined && hasBundledIntegrationLogo(providerKey)) {
    return (
      <IntegrationIcon
        providerKey={providerKey}
        displayName={null}
        logoUrl={null}
        size={24}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-6 shrink-0 items-center justify-center text-[var(--content-tertiary)]"
    >
      <KeyRound className="size-4" strokeWidth={2} />
    </span>
  );
}

type Tone = "primary" | "secondary" | "negative";

/**
 * A card's actions in footer order: the rest first and the primary last, so
 * the primary is rightmost, the order every footer in the app keeps. Stable
 * otherwise, so the assistant's own order among the rest stands.
 */
const actionsInOrder = (
  actions: readonly CompanionPopoverAction[],
): CompanionPopoverAction[] => [
  ...actions.filter((action) => action.style !== "primary"),
  ...actions.filter((action) => action.style === "primary"),
];

/** The design library's variant for a card action, as its footers use them. */
const variantForAction = (
  action: CompanionPopoverAction,
): "primary" | "danger" | "outlined" => {
  switch (action.style) {
    case "primary":
      return "primary";
    case "destructive":
      return "danger";
    case "secondary":
      return "outlined";
  }
};

/**
 * The design library's button in the popover's pill shape: its primary fill,
 * a lifted neutral, and its negative tint held at rest rather than on hover.
 */
export function PillButton({
  tone,
  onClick,
  type = "button",
  disabled,
  children,
}: {
  tone: Tone;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type={type}
      disabled={disabled}
      variant={
        tone === "primary"
          ? "primary"
          : tone === "negative"
            ? "dangerGhost"
            : "ghost"
      }
      className={cn(
        "h-8 rounded-full px-3",
        tone === "secondary" &&
          "bg-[var(--surface-lift)] hover:bg-[var(--surface-active)]",
        tone === "negative" && "bg-[var(--system-negative-weak)]",
      )}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
