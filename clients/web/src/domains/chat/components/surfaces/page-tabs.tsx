import { Tabs } from "@vellumai/design-library";

import type { FormPage } from "@/domains/chat/components/surfaces/form-surface";

interface PageTabsProps {
  current: number;
  pages: FormPage[];
  onNavigate: (index: number) => void;
}

/**
 * Labeled step tabs for a multi-page form. The current page is active,
 * completed pages (before the current one) are clickable to navigate
 * back, and future pages are disabled — forward navigation goes through
 * the Next button. Built on the design library `Tabs` primitive for
 * keyboard navigation, focus handling, and consistent styling.
 */
export function PageTabs({ current, pages, onNavigate }: PageTabsProps) {
  return (
    <Tabs.Root
      value={pages[current]?.id}
      onValueChange={(value) => {
        const index = pages.findIndex((page) => page.id === value);
        if (index >= 0) onNavigate(index);
      }}
      className="mb-4"
    >
      <Tabs.List className="overflow-x-auto">
        {pages.map((page, i) => (
          <Tabs.Trigger key={page.id} value={page.id} disabled={i > current}>
            {i + 1}. {page.title}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
