// The map of this repo's two Storybooks and how to get from one to the other.
// One copy so the resolution rules cannot drift between the two toolbars, and
// here specifically because `packages/design-library/**` is already in the path
// filter that rebuilds both Storybooks (.github/workflows/ci-main-storybook.yaml).

export type StorybookId = "design-library" | "web";

export const STORYBOOKS: Record<
  StorybookId,
  { label: string; devPort: string }
> = {
  "design-library": { label: "Vellum Design Library", devPort: "6006" },
  web: { label: "Vellum Web", devPort: "6007" },
};

export type LocationLike = {
  protocol: string;
  hostname: string;
  pathname: string;
};

const HOSTED_ORIGIN = "https://storybook.vellum.ai";
const HOSTED_PATH = /^\/(?:design-library|web)\/([^/]+)\//;
const DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export function siblingOf(self: StorybookId): StorybookId {
  return self === "web" ? "design-library" : "web";
}

// Resolved from the current location rather than baked in at build time, so one
// artifact is correct hosted, in dev, and in a locally served static build.
export function resolveStorybookUrl(
  target: StorybookId,
  location: LocationLike,
): string {
  // Keep the version segment so this survives the per-version directories the
  // Storybook load balancer's path rules already allow for.
  const hosted = HOSTED_PATH.exec(location.pathname);
  if (hosted) {
    return `/${target}/${hosted[1]}/`;
  }
  if (DEV_HOSTNAMES.has(location.hostname)) {
    return `${location.protocol}//${location.hostname}:${STORYBOOKS[target].devPort}/`;
  }
  return `${HOSTED_ORIGIN}/${target}/main/`;
}
