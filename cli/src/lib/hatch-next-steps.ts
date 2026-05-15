export function logHatchNextSteps(
  log: (message: string) => void,
  instanceName: string,
): void {
  log("Next steps:");
  log("  vellum client");
  log('  vellum message "hello"');
  log("  vellum events");
  log("  vellum ps");
  log(`  vellum use ${instanceName}`);
  log("");
}
