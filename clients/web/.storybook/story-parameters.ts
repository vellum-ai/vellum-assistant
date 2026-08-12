/**
 * Routing context for a story, declared as `parameters.router`.
 *
 * Every story renders inside the one router the preview mounts. React Router
 * rejects a `<Router>` nested in another Router, so a story that needs a
 * particular address or route params configures this one rather than mounting
 * its own.
 *
 * https://reactrouter.com/api/declarative-routers/MemoryRouter
 */
export interface StoryRouterParameters {
  /** Address the story starts at. Defaults to `/`. */
  initialEntries?: string[];
  /**
   * Route patterns the story renders under. Set these when the component reads
   * `useParams()` or navigates, so the patterns matching the app's routes
   * resolve.
   *
   * Pass every pattern the story moves between, not only the one it starts on:
   * a component that navigates to an address no pattern matches renders
   * nothing.
   */
  paths?: string[];
}

/**
 * Storybook types `parameters` as an open bag of `any`, so a story's
 * `parameters.router` would be unchecked at both ends: the preview reading it
 * and the story writing it. Declaring the field on the interface types both,
 * which is what a shape the preview owns should be.
 *
 * https://storybook.js.org/docs/writing-stories/parameters
 * https://www.typescriptlang.org/docs/handbook/declaration-merging.html#module-augmentation
 */
declare module "storybook/internal/csf" {
  interface Parameters {
    router?: StoryRouterParameters;
  }
}
