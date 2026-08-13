import { useEffect, useRef, useState } from "react";

/**
 * Open-state for the two surfaces the composer's settings menus own, held above
 * the composer because its mobile pills row has to stay up while a sheet holds
 * the focus that would otherwise put the row away.
 *
 * `isMobile` is the presentation: the triggers sit in the composer's action row
 * on desktop and in the floating pills row on mobile, so crossing the
 * breakpoint (a phone rotating) unmounts whichever menu had a sheet open. That
 * instance reports nothing on its way out and its replacement suppresses the
 * initial `false`, so both flags reset on the swap. An open flag must never
 * outlive the instance that set it.
 */
export function useComposerSettingsSheets(isMobile: boolean): {
  settingsSheetOpen: boolean;
  onAccessOpenChange: (open: boolean) => void;
  onProfileOpenChange: (open: boolean) => void;
} {
  const [accessOpen, setAccessOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const presentationRef = useRef(isMobile);
  useEffect(() => {
    if (presentationRef.current === isMobile) {
      return;
    }
    presentationRef.current = isMobile;
    setAccessOpen(false);
    setProfileOpen(false);
  }, [isMobile]);

  // The setters are React's own, so they stay referentially stable: the menu
  // notifies through an effect that lists its callback as a dependency.
  return {
    settingsSheetOpen: accessOpen || profileOpen,
    onAccessOpenChange: setAccessOpen,
    onProfileOpenChange: setProfileOpen,
  };
}
