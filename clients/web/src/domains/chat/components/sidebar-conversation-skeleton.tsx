/**
 * Placeholder rows shown while the sidebar's conversation list is still
 * loading.
 *
 * The list arrives as one query that resolves only after every page of it has
 * been fetched (see `fetchConversationList`), so on a cold load there is a
 * stretch (proportional to how many conversations the assistant has) where
 * the sidebar has no rows to draw. Without this the sidebar renders an empty
 * scrollport, which reads as "you have no conversations" rather than "these
 * are on their way": the two states looked identical, and the difference
 * between them is the whole reason a user reaches for the menu.
 *
 * Deliberately fixed-width bars rather than randomized ones: the widths only
 * have to break the grid enough to read as titles, and a stable set can't
 * reflow between renders.
 */

import { SkeletonBar } from "@/domains/chat/components/chat-skeleton";

/**
 * Row widths, as Tailwind fraction utilities. Enough rows to fill the
 * scrollport on a short viewport without implying a specific list length.
 */
const ROW_WIDTHS = [
  "w-4/5",
  "w-3/5",
  "w-11/12",
  "w-2/3",
  "w-3/4",
  "w-1/2",
  "w-5/6",
] as const;

export function SidebarConversationSkeleton() {
  return (
    /* `gap-1` + the 30px row height restate the real list's row rhythm, so
       rows don't shift vertically when the real ones replace these. */
    /* `role="status"` rather than `aria-hidden`: telling loading apart from
       "no conversations" is the whole point of this component, and a screen
       reader given only decorative bars would be back to a silently empty
       list. The bars themselves carry no text, so the label is the only thing
       announced. */
    <div
      className="flex flex-col gap-1"
      data-slot="sidebar-conversation-skeleton"
      role="status"
      aria-label="Loading conversations"
    >
      {ROW_WIDTHS.map((width, index) => (
        <div
          key={index}
          className="flex h-[30px] items-center"
          style={{ paddingInline: 6 }}
        >
          <SkeletonBar className={`h-3.5 ${width}`} />
        </div>
      ))}
    </div>
  );
}
