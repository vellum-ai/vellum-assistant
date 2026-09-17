import { useCompanionIntroStaged } from "@/runtime/companion-intro-stage";

/**
 * The app dimmed for the length of the companion's introduction.
 *
 * The surface is a window of its own, floating above this one, so the run is
 * already on top of whatever the app is showing. What it is not is the only
 * thing on screen: a pill introducing itself over a full chat window competes
 * with every control behind it, and the first thing a new user is asked to
 * look at is the one thing they have no reason to look at yet. So the app
 * stands down for a moment: the window goes dark, nothing in it can be
 * pressed, and the creature and its card are the only lit things left.
 *
 * It covers the app's own window and nothing else. Main holds the surface in
 * front for the same stretch (`introStaged` in `companion-window.ts`), and
 * lifts the dimming as the surface leaves for its home on the desktop, so what
 * is lit while it travels is the desktop it is travelling to.
 *
 * Presentational and inert: no copy, no focus, and no way to answer the run
 * from here. The run is answered on the surface, which carries its own way out
 * and its own way on, and every path out of it goes through main.
 */
export function CompanionIntroScrim() {
  const staged = useCompanionIntroStaged();
  return (
    <div
      // Not `hidden`: the fade is the point. A scrim that appeared and
      // disappeared outright would read as the window breaking rather than
      // standing aside.
      aria-hidden
      // Above everything the app draws, since the point is that none of it is
      // reachable. The pointer is taken while it is up and given back the
      // moment it is not, which is what makes this inert rather than a
      // permanent lid.
      className={`fixed inset-0 z-[100] bg-black/75 transition-opacity duration-500 ${
        staged ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    />
  );
}
