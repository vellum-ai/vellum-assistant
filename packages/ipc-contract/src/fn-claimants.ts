/**
 * Other dictation apps that watch Fn the way the voice key does.
 *
 * Nothing on macOS owns a key: every app with Input Monitoring hears the same
 * press, so a hold of Fn with one of these running dictates twice. Known by
 * bundle identifier, since that is the one name a running app cannot change.
 *
 * In the contract rather than the renderer because the main process holds
 * the list too: the one action the renderer can take against another app
 * (asking it to quit) is allowed for these and no others.
 */
export interface FnClaimant {
  bundleId: string;
  /** How the app names itself, for the notice that says it is here. */
  name: string;
}

export const FN_CLAIMANTS: readonly FnClaimant[] = [
  { bundleId: "com.electron.wispr-flow", name: "Wispr Flow" },
];

export const FN_CLAIMANT_BUNDLE_IDS: readonly string[] = FN_CLAIMANTS.map(
  (app) => app.bundleId,
);
