import * as Sentry from "@sentry/node";
import { APP_VERSION } from "./version.js";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: `vellum-assistant@${APP_VERSION}`,
  environment: APP_VERSION === "0.0.0-dev" ? "development" : "production",
  sendDefaultPii: true,
});
