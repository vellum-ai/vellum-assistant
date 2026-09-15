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
 *
 * {@link CompanionPromptRow} is the short form on its own, which a call's bar
 * also carries as a row of its own. Presentational: the pages own the windows,
 * the state and the presses, so everything here renders in Storybook and
 * tests as it is.
 */

import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
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

import { IntegrationIcon } from "@/components/integrations/integration-icon";
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
  assistantName: string;
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
 * The ground of a popover drawn whole: a dark panel with a soft rim and a
 * gradient faintly tinted in the assistant's colour.
 *
 * A gradient rather than a blur of what is behind it. The popover is a window
 * of its own over another application, and a page cannot see what another
 * window draws, so the tint is what gives the panel the colour a glass one
 * would pick up.
 */
const panelBackground = (accentHex: string | undefined): string => {
  const tint =
    accentHex === undefined
      ? "#2a2b2e"
      : `color-mix(in srgb, ${accentHex} 14%, #26272a)`;
  return `linear-gradient(145deg, ${tint} 0%, #242528 55%, #1e1f21 100%)`;
};

export function CompanionPopover({
  popover,
  view,
  assistantName,
  cardRef,
  onAnswer,
  onView,
  onOpenLink,
  accentHex,
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
          "w-max max-w-[496px] rounded-full",
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
        "flex flex-col gap-4 rounded-[20px] border border-white/10 p-5 text-[var(--content-default)] shadow-2xl shadow-black/50",
        popover.kind === "approvals" ? "w-max max-w-[496px]" : "w-[360px]",
        className,
      )}
      style={{ background: panelBackground(accentHex), ...style }}
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
      ) : (
        <SurfaceCard
          popover={popover}
          assistantName={assistantName}
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
        "flex h-11 min-w-0 items-center gap-1.5 pr-1.5 text-[var(--content-default)]",
        popover.kind === "secret" ? "pl-2" : "pl-4",
        className,
      )}
    >
      {popover.kind === "secret" ? (
        <ServiceIcon
          service={popover.service}
          providerKey={popover.providerKey}
        />
      ) : null}
      <span
        dir="auto"
        className="min-w-0 flex-1 truncate text-body-medium-default"
        title={single ? first?.title : undefined}
      >
        {popover.kind === "secret"
          ? popover.service !== ""
            ? t("companionPopover.needsCredentialsFor", {
                service: popover.service,
              })
            : t("companionPopover.needsCredentials")
          : single && first !== undefined
            ? first.title
            : t("companionPopover.needsOkCount", {
                count: popover.items.length,
              })}
      </span>
      <span className="ml-2 flex shrink-0 items-center gap-1">
        {single && first !== undefined ? (
          <ApprovalAnswers item={first} onAnswer={onAnswer} />
        ) : (
          <>
            <PillButton tone="primary" onClick={() => onView?.("expanded")}>
              {popover.kind === "secret"
                ? t("companionPopover.enter")
                : t("companionPopover.review")}
            </PillButton>
            <PillButton tone="secondary" onClick={() => onView?.("deferred")}>
              {t("companionPopover.notNow")}
            </PillButton>
          </>
        )}
      </span>
    </div>
  );
}

function ApprovalAnswers({
  item,
  onAnswer,
}: {
  item: CompanionApproval;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PillButton
        tone="primary"
        onClick={() =>
          onAnswer?.({
            // A permission request's allow opens the pane it asks for too.
            kind: item.permission === undefined ? "allow" : "settings",
            itemId: item.id,
          })
        }
      >
        {t("companionPopover.allow")}
      </PillButton>
      <PillButton
        tone="negative"
        onClick={() => onAnswer?.({ kind: "deny", itemId: item.id })}
      >
        {t("companionPopover.deny")}
      </PillButton>
    </>
  );
}

/**
 * A panel's header: a quiet title, and the close at the far end. What closing
 * means is the caller's: putting a prompt off, or dismissing a card.
 */
function PopoverHeader({
  title,
  icon,
  onClose,
}: {
  title: string;
  icon?: ReactNode;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="-mt-1 -mr-2 flex min-h-8 items-center gap-2">
      {icon}
      <p
        dir="auto"
        className="min-w-0 flex-1 truncate text-body-medium-default text-[var(--content-tertiary)] select-none"
      >
        {title}
      </p>
      <Button
        variant="ghost"
        className="size-8 rounded-lg px-0"
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
      className="max-h-[480px] flex-col"
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
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate pl-1 text-body-medium-default"
              title={item.detail !== "" ? item.detail : item.title}
            >
              {item.title}
            </span>
            <span className="ml-2 flex shrink-0 items-center gap-1">
              <ApprovalAnswers item={item} onAnswer={onAnswer} />
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

  // Focused on arrival, so typing lands here once main lends the window the
  // keyboard.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== "") {
          onAnswer?.({ kind: "secret", value });
        }
      }}
    >
      <PopoverHeader
        icon={
          <ServiceIcon
            service={popover.service}
            providerKey={popover.providerKey}
          />
        }
        title={
          popover.service !== ""
            ? t("companionPopover.needsCredentialsFor", {
                service: popover.service,
              })
            : t("companionPopover.needsCredentials")
        }
        onClose={() => onView?.("deferred")}
      />
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
      <div className="flex items-center justify-center gap-1">
        <PillButton tone="primary" type="submit" disabled={value === ""}>
          {t("companionPopover.confirm")}
        </PillButton>
        <PillButton tone="secondary" onClick={() => onView?.("deferred")}>
          {t("companionPopover.notNow")}
        </PillButton>
      </div>
    </form>
  );
}

/** A card in full, or a surface the popover can only name. */
function SurfaceCard({
  popover,
  assistantName,
  onAnswer,
  onOpenLink,
}: {
  popover: Extract<CompanionPopoverContent, { kind: "card" | "surface" }>;
  assistantName: string;
  onAnswer?: (answer: CompanionPopoverAnswer) => void;
  onOpenLink?: (url: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PopoverHeader
        title={assistantName}
        onClose={() => onAnswer?.({ kind: "dismiss" })}
      />
      {popover.kind === "card" ? (
        <>
          {popover.title !== "" || popover.subtitle !== "" ? (
            <div className="flex flex-col gap-0.5">
              {popover.title !== "" ? (
                <p dir="auto" className="text-title-small leading-snug">
                  {popover.title}
                </p>
              ) : null}
              {popover.subtitle !== "" ? (
                <p
                  dir="auto"
                  className="text-body-medium-lighter text-[var(--content-tertiary)]"
                >
                  {popover.subtitle}
                </p>
              ) : null}
            </div>
          ) : null}
          {popover.body !== "" ? (
            <CardBody body={popover.body} onOpenLink={onOpenLink} />
          ) : null}
          {popover.actions.length > 0 ? (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {popover.actions.map((action) => (
                <PillButton
                  key={action.id}
                  tone={toneForAction(action)}
                  onClick={() =>
                    onAnswer?.({ kind: "action", actionId: action.id })
                  }
                >
                  {action.label}
                </PillButton>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p dir="auto" className="text-title-small leading-snug">
            {popover.title !== ""
              ? popover.title
              : t("companionPopover.surfaceFallback")}
          </p>
          <div className="flex items-center justify-end">
            <PillButton
              tone="primary"
              onClick={() => onAnswer?.({ kind: "open" })}
            >
              {t("companionPopover.openApp")}
            </PillButton>
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
    <ScrollShadow
      className="max-h-[400px] flex-col"
      size={20}
      fadeEdges="end"
      hideScrollBar
    >
      <MarkdownMessage
        content={body}
        className="text-body-medium-lighter text-[var(--content-secondary)]"
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
      className="my-1 max-h-60 w-full rounded-xl object-contain"
    />
  ) : null;

/** The logo of the service a credential is for, or its initials. */
function ServiceIcon({
  service,
  providerKey,
}: {
  service: string;
  providerKey?: string;
}) {
  if (service === "") {
    return null;
  }
  return (
    <IntegrationIcon
      providerKey={providerKey ?? service}
      displayName={service}
      logoUrl={null}
      size={28}
    />
  );
}

type Tone = "primary" | "secondary" | "negative";

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
