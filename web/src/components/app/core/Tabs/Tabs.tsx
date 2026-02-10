"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentPropsWithoutRef, forwardRef } from "react";

import { cn } from "@/lib/utils";

/* ───────────── Tabs (root) ───────────── */

const Tabs = TabsPrimitive.Root;

/* ───────────── TabsList ───────────── */

const tabsListVariants = cva("flex items-center", {
  variants: {
    variant: {
      underline: "border-b border-cloud-200 dark:border-sky-700",
      pill: "rounded-meadow bg-cloud-100 p-1 dark:bg-sky-800",
    },
  },
  defaultVariants: {
    variant: "underline",
  },
});

interface TabsListProps
  extends
    ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
    VariantProps<typeof tabsListVariants> {}

const TabsList = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(tabsListVariants({ variant, className }))}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/* ───────────── TabsTrigger ───────────── */

const tabsTriggerVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap font-display text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dino-400/30 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        underline:
          "border-b-2 border-transparent px-4 py-2 text-cloud-500 hover:text-sky-900 dark:text-sky-400 dark:hover:text-white data-[state=active]:border-poppy-400 data-[state=active]:text-poppy-500",
        pill: "rounded-meadow px-3 py-1.5 text-cloud-500 dark:text-sky-400 data-[state=active]:bg-white data-[state=active]:text-sky-900 data-[state=active]:shadow-sm dark:data-[state=active]:bg-sky-700 dark:data-[state=active]:text-white",
      },
    },
    defaultVariants: {
      variant: "underline",
    },
  },
);

interface TabsTriggerProps
  extends
    ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>,
    VariantProps<typeof tabsTriggerVariants> {}

const TabsTrigger = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(tabsTriggerVariants({ variant, className }))}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/* ───────────── TabsContent ───────────── */

const TabsContent = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn(className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
