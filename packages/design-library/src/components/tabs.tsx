import * as RadixTabs from "@radix-ui/react-tabs";
import { type ComponentProps } from "react";

import { cn } from "../utils/cn";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export type TabsRootProps = ComponentProps<typeof RadixTabs.Root>;

function TabsRoot({ className, ref, ...rest }: TabsRootProps) {
  return (
    <RadixTabs.Root
      ref={ref}
      data-slot="tabs"
      className={className}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type TabsListProps = ComponentProps<typeof RadixTabs.List>;

function TabsList({ className, ref, ...rest }: TabsListProps) {
  return (
    <RadixTabs.List
      ref={ref}
      data-slot="tabs-list"
      className={cn(
        "flex items-center border-b border-[var(--border-base)]",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export type TabsTriggerProps = ComponentProps<typeof RadixTabs.Trigger>;

function TabsTrigger({ className, ref, ...rest }: TabsTriggerProps) {
  return (
    <RadixTabs.Trigger
      ref={ref}
      data-slot="tabs-trigger"
      className={cn(
        "relative -mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent bg-transparent px-2.5 py-[7px]",
        "text-body-medium-default whitespace-nowrap",
        "text-[var(--content-tertiary)] transition-colors",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
        "hover:bg-[var(--surface-hover)] hover:text-[var(--content-default)]",
        "data-[state=active]:border-[var(--primary-base)] data-[state=active]:text-[var(--content-default)]",
        "data-[state=active]:hover:bg-transparent",
        "disabled:cursor-not-allowed disabled:text-[var(--content-disabled)]",
        "disabled:hover:bg-transparent disabled:hover:text-[var(--content-disabled)]",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export type TabsPanelProps = ComponentProps<typeof RadixTabs.Content>;

function TabsPanel({ className, ref, ...rest }: TabsPanelProps) {
  return (
    <RadixTabs.Content
      ref={ref}
      data-slot="tabs-panel"
      className={cn(
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
        className,
      )}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Trigger: TabsTrigger,
  Panel: TabsPanel,
} as const;

export { Tabs, TabsRoot, TabsList, TabsTrigger, TabsPanel };
