/**
 * Other apps that take the voice key before Vellum sees it.
 *
 * Nothing on macOS owns a key: every app with Input Monitoring hears the same
 * press, and a keyboard tool that remaps the key can take it out of the stream
 * altogether. Known by bundle identifier, since that is the one name a running
 * app cannot change.
 *
 * In the contract rather than the renderer because the main process holds
 * the list too: the one action the renderer can take against another app
 * (asking it to quit) is allowed for the entries that say so and no others.
 */
export interface FnClaimant {
  bundleId: string;
  /** How the app names itself, for the notice that says it is here. */
  name: string;
  /**
   * Whether Vellum offers to quit it. Only a dictation app that fires on the
   * same hold is worth getting out of the way; a keyboard tool holds the key
   * because the user set it to, and is named so they know where to look.
   */
  quittable: boolean;
}

export const FN_CLAIMANTS: readonly FnClaimant[] = [
  { bundleId: "com.electron.wispr-flow", name: "Wispr Flow", quittable: true },
  {
    bundleId: "org.pqrs.Karabiner-Elements.Settings",
    name: "Karabiner-Elements",
    quittable: false,
  },
  // The user-session agent from Karabiner-Elements 16 on, which folded the
  // menu bar app into it. Earlier installs run the menu bar app instead.
  {
    bundleId: "org.pqrs.Karabiner-Console-User-Server",
    name: "Karabiner-Elements",
    quittable: false,
  },
  {
    bundleId: "org.pqrs.Karabiner-Menu",
    name: "Karabiner-Elements",
    quittable: false,
  },
  { bundleId: "com.raycast.macos", name: "Raycast", quittable: false },
  {
    bundleId: "com.hegenberg.BetterTouchTool",
    name: "BetterTouchTool",
    quittable: false,
  },
];

/** Every claimant the app may ask about and name. */
export const FN_CLAIMANT_BUNDLE_IDS: readonly string[] = FN_CLAIMANTS.map(
  (app) => app.bundleId,
);

/** The claimants the app may ask to quit. */
export const FN_CLAIMANT_QUIT_BUNDLE_IDS: readonly string[] =
  FN_CLAIMANTS.filter((app) => app.quittable).map((app) => app.bundleId);
