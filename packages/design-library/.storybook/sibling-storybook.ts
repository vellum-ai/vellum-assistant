// The two Storybooks publish to sibling prefixes under one host, so the link
// target is derived from the current location rather than baked in at build
// time. See .github/workflows/ci-main-storybook.yaml.
const SIBLING_SLUG = "web";
const SIBLING_DEV_PORT = "6007";
const HOSTED_ORIGIN = "https://storybook.vellum.ai";

const HOSTED_PATH = /^\/(?:web|design-library)\/([^/]+)\//;
const DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export const SIBLING_STORYBOOK_LABEL = "Vellum Web";

type LocationLike = Pick<Location, "protocol" | "hostname" | "pathname">;

export function resolveSiblingStorybookUrl(location: LocationLike): string {
  // Keep the version segment so this survives the per-version directories the
  // Storybook load balancer's path rules already allow for.
  const hosted = HOSTED_PATH.exec(location.pathname);
  if (hosted) {
    return `/${SIBLING_SLUG}/${hosted[1]}/`;
  }
  if (DEV_HOSTNAMES.has(location.hostname)) {
    return `${location.protocol}//${location.hostname}:${SIBLING_DEV_PORT}/`;
  }
  return `${HOSTED_ORIGIN}/${SIBLING_SLUG}/main/`;
}
