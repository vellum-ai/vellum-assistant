/**
 * The signal a row sends its own section header when it is marked done.
 *
 * The row leaves the list and the chat is not gone, it is on the Old chats
 * page, so the header's "View all chats" icon flashes once as the row goes:
 * the eye follows the departing row to the place it went. The signal is a
 * counter rather than a boolean so two rows checked in a row each get their
 * own flash.
 *
 * Section-scoped on purpose. A store would make every header on screen flash
 * for a row in one of them, and the point of the flash is that it names one
 * destination.
 *
 * Outside a provider (the rail flyout, the Old chats page, a test) the
 * default context is inert, so a row can always call {@link flash}.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SectionDoneFlashValue {
  /** Increments once per row marked done in this section. */
  count: number;
  flash: () => void;
}

const NO_FLASH: SectionDoneFlashValue = { count: 0, flash: () => {} };

const SectionDoneFlashContext = createContext<SectionDoneFlashValue>(NO_FLASH);

export function SectionDoneFlashProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [count, setCount] = useState(0);
  const flash = useCallback(() => setCount((prev) => prev + 1), []);
  const value = useMemo(() => ({ count, flash }), [count, flash]);
  return (
    <SectionDoneFlashContext.Provider value={value}>
      {children}
    </SectionDoneFlashContext.Provider>
  );
}

export function useSectionDoneFlash(): SectionDoneFlashValue {
  return useContext(SectionDoneFlashContext);
}
