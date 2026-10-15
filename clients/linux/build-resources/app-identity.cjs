exports.resolveLinuxAppId = (environment) =>
  environment === "production"
    ? "com.vellum.vellum-assistant-electron"
    : `com.vellum.vellum-assistant-electron-${environment}`;
