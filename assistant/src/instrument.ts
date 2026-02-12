import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992",
  sendDefaultPii: true,
});
