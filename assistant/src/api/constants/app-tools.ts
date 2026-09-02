/**
 * The app tools that mutate the stored app set, and what each one leaves
 * behind. Mirrors `document-tools.ts`: a single declaration both the daemon and
 * the web client derive their tool sets from, so a new mutating app tool is
 * added here once and every consumer picks it up.
 *
 * Tool names are the ones the runner sees. Calls arriving through the bundled
 * `app-builder` skill reach the daemon already unwrapped to the inner tool
 * name, and the web client unwraps the `skill_execute` envelope itself.
 */

export interface AppMutationTool {
  /** The executed tool name. */
  readonly name: string;
  /**
   * Whether the app is still openable once the tool has run. A deleted app has
   * nothing to open, so it cannot anchor a card back to itself.
   */
  readonly reopenable: boolean;
}

export const APP_MUTATION_TOOLS: readonly AppMutationTool[] = [
  { name: "app_create", reopenable: true },
  { name: "app_update", reopenable: true },
  { name: "app_delete", reopenable: false },
];

/**
 * The mutating app tools that leave the app openable. The web transcript
 * anchors its end-of-response app cards on these, so a delete never produces a
 * card pointing at an app that is gone.
 */
export const APP_MUTATION_TOOL_NAMES: readonly string[] =
  APP_MUTATION_TOOLS.filter((tool) => tool.reopenable).map((tool) => tool.name);
