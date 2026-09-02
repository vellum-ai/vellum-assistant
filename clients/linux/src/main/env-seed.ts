// Must be the first import in index.ts so that process.env.VELLUM_ENVIRONMENT
// is seeded before any other module reads it at module scope.
declare const __VELLUM_ENVIRONMENT__: string;

process.env.VELLUM_DESKTOP_APP = "1";

if (
  typeof __VELLUM_ENVIRONMENT__ === "string" &&
  !process.env.VELLUM_ENVIRONMENT
) {
  process.env.VELLUM_ENVIRONMENT = __VELLUM_ENVIRONMENT__;
}
