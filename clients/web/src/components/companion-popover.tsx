/**
 * The popover beside the companion: what the assistant needs the user to see
 * or answer while they talk to it away from the app's window. A tool approval,
 * a card with an image or a link, or the name of a surface the popover cannot
 * draw with a way into the app.
 *
 * Presentational. The page (`companion-popover-page.tsx`) owns the window, the
 * state and the presses, so this renders in Storybook and tests as it is.
 */

import { X } from "lucide-react";
import {
  useCallback,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";

import type {
  CompanionPopover as CompanionPopoverContent,
  CompanionPopoverAction,
  CompanionPopoverAnswer,
} from "@vellumai/ipc-contract";
import {
  MarkdownMessage,
  type MarkdownImageComponent,
  type MarkdownLinkComponent,
} from "@vellumai/design-library";
import { ScrollShadow } from "@vellumai/design-library/components/scroll-shadow";
import { defaultUrlTransform } from "react-markdown";

import { useTranslation } from "@/i18n";
import { cn } from "@/utils/misc";

export interface CompanionPopoverProps {
  popover: CompanionPopoverContent;
  assistantName: string;
  /** The card's element, for the page to measure. */
  cardRef?: Ref<HTMLDivElement>;
  /** Absent leaves the presses inert, which is what Storybook wants. */
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onOpenLink?: (url: string) => void;
  className?: string;
  style?: CSSProperties;
}

/** Whether an image source is one the popover draws: the web, or inline. */
export const drawsImageSource = (src: string): boolean =>
  /^https?:\/\//i.test(src) || /^data:image\//i.test(src);

export function CompanionPopover({
  popover,
  assistantName,
  cardRef,
  onAnswer,
  onOpenLink,
  className,
  style,
}: CompanionPopoverProps) {
  const { t } = useTranslation();
  const heading =
    popover.kind === "approval"
      ? t("companionPopover.approvalHeading")
      : assistantName;

  return (
    <div
      ref={cardRef}
      // A group rather than a dialog: the window never takes focus, so there
      // is nothing to trap, and every answer is the pointer's.
      role="group"
      aria-label={heading}
      data-companion-popover={popover.kind}
      className={cn(
        "flex flex-col gap-2 rounded-2xl border border-white/10 bg-[#17181b]/95 px-3.5 py-3 shadow-lg shadow-black/40",
        className,
      )}
      style={style}
    >
      <div className="flex min-h-5 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] font-medium tracking-wide text-white/45 uppercase select-none">
          {heading}
        </p>
        {popover.kind !== "approval" ? (
          <button
            type="button"
            aria-label={t("companionPopover.dismiss")}
            className="-mr-1 flex size-5 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white/80"
            onClick={() => onAnswer?.({ kind: "dismiss" })}
          >
            <X className="size-3.5" strokeWidth={2.5} />
          </button>
        ) : null}
      </div>
      <PopoverBody
        popover={popover}
        onAnswer={onAnswer}
        onOpenLink={onOpenLink}
      />
    </div>
  );
}

function PopoverBody({
  popover,
  onAnswer,
  onOpenLink,
}: Pick<CompanionPopoverProps, "popover" | "onAnswer" | "onOpenLink">) {
  const { t } = useTranslation();
  switch (popover.kind) {
    case "approval":
      return (
        <>
          <Title>{popover.title}</Title>
          {popover.detail !== "" ? <Detail>{popover.detail}</Detail> : null}
          <Actions>
            {/* Left out beside the longer permission answer, which would
                otherwise wrap the row. The creature still opens the app. */}
            {popover.permission === undefined ? (
              <PopoverButton
                tone="quiet"
                onClick={() => onAnswer?.({ kind: "open" })}
              >
                {t("companionPopover.openApp")}
              </PopoverButton>
            ) : null}
            <PopoverButton
              tone="negative"
              onClick={() => onAnswer?.({ kind: "deny" })}
            >
              {t("companionPopover.deny")}
            </PopoverButton>
            <PopoverButton
              tone="primary"
              onClick={() =>
                onAnswer?.({
                  kind: popover.permission === undefined ? "allow" : "settings",
                })
              }
            >
              {popover.permission === undefined
                ? t("companionPopover.allow")
                : t("companionPopover.allowAndOpenSettings")}
            </PopoverButton>
          </Actions>
        </>
      );
    case "card":
      return (
        <>
          {popover.title !== "" ? <Title>{popover.title}</Title> : null}
          {popover.subtitle !== "" ? <Detail>{popover.subtitle}</Detail> : null}
          {popover.body !== "" ? (
            <CardBody body={popover.body} onOpenLink={onOpenLink} />
          ) : null}
          {popover.actions.length > 0 ? (
            <Actions>
              {popover.actions.map((action) => (
                <PopoverButton
                  key={action.id}
                  tone={toneForAction(action)}
                  onClick={() =>
                    onAnswer?.({ kind: "action", actionId: action.id })
                  }
                >
                  {action.label}
                </PopoverButton>
              ))}
            </Actions>
          ) : null}
        </>
      );
    case "surface":
      return (
        <>
          <Title>
            {popover.title !== ""
              ? popover.title
              : t("companionPopover.surfaceFallback")}
          </Title>
          <Actions>
            <PopoverButton
              tone="primary"
              onClick={() => onAnswer?.({ kind: "open" })}
            >
              {t("companionPopover.openApp")}
            </PopoverButton>
          </Actions>
        </>
      );
  }
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
        className="text-white underline decoration-white/40 underline-offset-2 hover:decoration-white"
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
    <ScrollShadow
      className="max-h-[400px] flex-col"
      size={20}
      fadeEdges="end"
      hideScrollBar
    >
      <MarkdownMessage
        content={body}
        className="text-[13px] leading-[1.45] text-white/85"
        linkComponent={link}
        imageComponent={PopoverImage}
        urlTransform={popoverUrlTransform}
      />
    </ScrollShadow>
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
      className="my-1 max-h-60 w-full rounded-lg object-contain"
    />
  ) : null;

function Title({ children }: { children: ReactNode }) {
  return (
    <p
      dir="auto"
      className="text-[13px] leading-[1.4] font-medium text-white/90"
    >
      {children}
    </p>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return (
    <p dir="auto" className="text-[12px] leading-[1.4] text-white/60">
      {children}
    </p>
  );
}

/** The row of answers, primary last so it lands on the right. */
function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 pt-0.5">
      {children}
    </div>
  );
}

type Tone = "quiet" | "secondary" | "primary" | "negative";

const toneForAction = (action: CompanionPopoverAction): Tone => {
  switch (action.style) {
    case "primary":
      return "primary";
    case "destructive":
      return "negative";
    case "secondary":
      return "secondary";
  }
};

const TONE_CLASS: Record<Tone, string> = {
  quiet: "text-white/55 hover:bg-white/10 hover:text-white/80",
  secondary: "text-white/80 hover:bg-white/10 hover:text-white",
  primary: "bg-white/15 text-white hover:bg-white/25",
  negative: "text-red-300 hover:bg-red-500/15 hover:text-red-200",
};

function PopoverButton({
  tone,
  onClick,
  children,
}: {
  tone: Tone;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "h-7 rounded-full px-3 text-[12px] transition-colors",
        TONE_CLASS[tone],
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
