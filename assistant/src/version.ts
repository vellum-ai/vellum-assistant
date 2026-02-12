// Version is embedded at compile time via --define in CI.
// Falls back to "0.0.0-dev" for local development.
export const APP_VERSION: string = process.env.APP_VERSION ?? "0.0.0-dev";
