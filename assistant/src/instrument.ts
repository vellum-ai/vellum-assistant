import * as Sentry from "@sentry/node";
import { APP_VERSION } from "./version.js";

Sentry.init({
  dsn: "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992",
  release: `vellum-assistant@${APP_VERSION}`,
  environment: APP_VERSION === "0.0.0-dev" ? "development" : "production",
  sendDefaultPii: true,
});
