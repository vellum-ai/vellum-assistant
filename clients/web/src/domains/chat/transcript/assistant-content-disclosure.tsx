import { type ReactNode, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible } from "@vellumai/design-library";

const EARLIER_ACTIVITY_VALUE = "earlier-activity";

export interface AssistantContentDisclosureProps {
  children: ReactNode;
  isStreaming?: boolean;
}

/**
 * Collapses the intermediate work in a completed assistant response while
 * keeping it available on demand.
 */
export function AssistantContentDisclosure({
  children,
  isStreaming = false,
}: AssistantContentDisclosureProps) {
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
          className={`group w-fit flex-none gap-1 py-1 text-body-small-default text-[var(--content-secondary)] transition-[color,opacity] [animation-duration:var(--anim-standard)] duration-[var(--anim-standard)] ease-[var(--anim-spring)] hover:text-[var(--content-default)] motion-reduce:animate-none motion-reduce:transition-none ${!isStreaming && animateOnSettle ? "animate-in fade-in" : ""}`}
        >
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 transition-transform duration-[var(--anim-standard)] ease-[var(--anim-spring)] group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          />
          <span>Earlier activity</span>
        </Collapsible.Trigger>
        <Collapsible.Content
          data-testid="assistant-earlier-activity"
          style={{
            animationDuration: "var(--anim-standard)",
          }}
          className="flex origin-top flex-col gap-2 pb-2 transition-[opacity,transform] ease-[var(--anim-spring)] data-[state=closed]:-translate-y-1 data-[state=closed]:opacity-0 data-[state=open]:translate-y-0 data-[state=open]:opacity-100 motion-reduce:translate-y-0 motion-reduce:animate-none motion-reduce:transition-none"
        >
          {children}
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
