import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible } from "@vellumai/design-library";

export interface AssistantContentDisclosureProps {
  children: ReactNode;
}

/**
 * Collapses the intermediate work in a completed assistant response while
 * keeping it available on demand.
 */
export function AssistantContentDisclosure({
  children,
}: AssistantContentDisclosureProps) {
  return (
    <Collapsible.Root type="single" collapsible>
      <Collapsible.Item value="earlier-activity">
        <Collapsible.Trigger className="group w-fit flex-none gap-1 py-1 text-body-small-default text-[var(--content-secondary)] transition-colors hover:text-[var(--content-default)]">
          <ChevronRight
            aria-hidden
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90"
          />
          <span>Earlier activity</span>
        </Collapsible.Trigger>
        <Collapsible.Content
          data-testid="assistant-earlier-activity"
          className="flex flex-col gap-2 pb-2"
        >
          {children}
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
