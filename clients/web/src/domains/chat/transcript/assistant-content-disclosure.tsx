import { type ReactNode, useEffect, useState } from "react";
import { Bolt, ChevronRight } from "lucide-react";
import { Collapsible } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { IconName } from "@/domains/chat/components/tool-progress-card/derive-step-label";
import { ICON_MAP } from "@/domains/chat/components/tool-progress-card/phase-grouped-step-list";
import { cn } from "@/utils/misc";

const EARLIER_ACTIVITY_VALUE = "earlier-activity";

/** One collapsed group, plus the glyph that marks it on the timeline. */
export interface AssistantContentDisclosureItem {
  key: string;
  node: ReactNode;
  /**
   * Timeline glyph for this row, from the same `ICON_MAP` the steps panel and
   * step pills read, so a collapsed run and its expanded drawer never drift.
   * Omitted for prose, which keeps the gutter slot but shows no glyph.
   */
  iconName?: IconName;
}

export interface AssistantContentDisclosureProps {
  items: AssistantContentDisclosureItem[];
  isStreaming?: boolean;
}

/**
 * Collapses the intermediate work in a completed assistant response while
 * keeping it available on demand.
 *
 * The trigger is styled as one more inline activity link — same 13px medium
 * label, same `--content-secondary` tone, same trailing `ChevronRight` as
 * `SingleActivity` — so the row that turns the section reads as a peer of the
 * rows it reveals rather than a second kind of control.
 *
 * The revealed run is a *branch* of the response, so it renders as a timeline:
 * each activity group takes a glyph in a fixed gutter, with a connector segment
 * running between consecutive glyphs. The gutter both nests those rows (their
 * labels sit ~22px in, under the trigger's text) and separates the trigger's
 * chevron from the rows' own trailing "opens the drawer" chevrons. Prose has no
 * glyph, so it spans the gutter too and starts flush with the glyph column.
 */
export function AssistantContentDisclosure({
  items,
  isStreaming = false,
}: AssistantContentDisclosureProps) {
  const { t } = useTranslation("chat");
  const [animateOnSettle] = useState(isStreaming);
  const [value, setValue] = useState(
    isStreaming ? EARLIER_ACTIVITY_VALUE : "",
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setValue(isStreaming ? EARLIER_ACTIVITY_VALUE : ""),
    );
    return () => cancelAnimationFrame(frame);
  }, [isStreaming]);

  return (
    <Collapsible.Root
      type="single"
      collapsible
      value={isStreaming ? EARLIER_ACTIVITY_VALUE : value}
      onValueChange={setValue}
    >
      <Collapsible.Item value={EARLIER_ACTIVITY_VALUE}>
        <Collapsible.Trigger
          hidden={isStreaming}
          className={cn(
            "group -mx-1.5 w-fit flex-none items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] font-medium",
            "text-[var(--content-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
            // Open IS the active state, and it wears the hover treatment: the
            // trigger stays lit for as long as the run it opened is showing,
            // the same way a `MultiActivityGroup` header holds `surface-hover`
            // while its panel is up.
            "data-[state=open]:bg-[var(--surface-hover)] data-[state=open]:text-[var(--content-default)]",
            "[animation-duration:var(--anim-standard)] motion-reduce:animate-none motion-reduce:transition-none",
            !isStreaming && animateOnSettle && "animate-in fade-in",
          )}
        >
          <span>{t("assistantContentDisclosure.earlierActivity")}</span>
          {/* Same rule as the inline activity rows: the chevron shows when the
              trigger is reachable (hover / keyboard focus) or already open, so
              a settled response carries a label rather than a glyph. */}
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 text-[var(--content-tertiary)] opacity-0 transition-[transform,opacity] duration-[var(--anim-standard)] ease-[var(--anim-spring)] group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[state=open]:rotate-90 group-data-[state=open]:opacity-100 motion-reduce:transition-none"
          />
        </Collapsible.Trigger>
        <Collapsible.Content
          data-testid="assistant-earlier-activity"
          style={{
            animationDuration: "var(--anim-standard)",
          }}
          className="origin-top pb-2 transition-[opacity,transform] ease-[var(--anim-spring)] data-[state=closed]:-translate-y-1 data-[state=closed]:opacity-0 data-[state=open]:translate-y-0 data-[state=open]:opacity-100 motion-reduce:translate-y-0 motion-reduce:animate-none motion-reduce:transition-none"
        >
          {/* While streaming there is no trigger and nothing has been collapsed
              yet: this is the live turn's own work, which stays flush with the
              response. The timeline arrives with the trigger when the turn
              settles, under cover of the collapse animation. */}
          {isStreaming ? (
            <div className="flex flex-col gap-2">
              {items.map((item) => (
                <div key={item.key} className="w-full">
                  {item.node}
                </div>
              ))}
            </div>
          ) : (
            // 2px of daylight between the trigger's text and the glyph column
            // below it, so the timeline reads as nested under the trigger
            // rather than hanging off the same edge. `pt-1.5` sets the run off
            // from the trigger — the first row's own glyph slot is centered, so
            // without it the two rows crowd each other.
            <div className="flex flex-col pl-[2px] pt-1.5">
              {items.map((item, index) => {
                const Glyph = item.iconName
                  ? (ICON_MAP[item.iconName] ?? Bolt)
                  : null;
                const isLast = index === items.length - 1;
                // A row with no glyph (prose) takes the gutter's width too, so
                // it starts at the same x as the glyphs rather than at the
                // labels beside them — its own left edge is the alignment cue.
                if (!Glyph) {
                  return (
                    <div
                      key={item.key}
                      data-testid="earlier-activity-row"
                      className="w-full min-w-0"
                    >
                      {item.node}
                      {/* The row owns the gutter, so its connector cannot run
                          beside it — it runs under it instead, in the same
                          centered column the glyph rows use, keeping the
                          timeline unbroken across prose. */}
                      {isLast ? null : (
                        <div
                          aria-hidden
                          className="flex h-2 w-3.5 justify-center"
                        >
                          <span className="w-px bg-[var(--border-subtle)]" />
                        </div>
                      )}
                    </div>
                  );
                }
                return (
                  <div
                    key={item.key}
                    data-testid="earlier-activity-row"
                    className="flex gap-2"
                  >
                    <div className="flex w-3.5 shrink-0 flex-col items-center">
                      {/* Fixed-height slot centers the glyph on the row's first
                          line — a `SingleActivity` link is 28px tall. */}
                      <span className="flex h-7 shrink-0 items-center justify-center">
                        <Glyph
                          aria-hidden
                          className="size-3.5 shrink-0 text-[var(--content-tertiary)]"
                        />
                      </span>
                      {isLast ? null : (
                        <span
                          aria-hidden
                          className="w-px flex-1 bg-[var(--border-subtle)]"
                        />
                      )}
                    </div>
                    <div className={cn("min-w-0 flex-1", !isLast && "pb-2")}>
                      {item.node}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
