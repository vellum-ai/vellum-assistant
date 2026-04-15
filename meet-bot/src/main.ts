/**
 * meet-bot entry point.
 *
 * This is the bootstrap skeleton for the Meet bot — the container-side process
 * that will join a Google Meet session on behalf of an AI assistant so the
 * assistant can listen in (and eventually participate).
 *
 * The real implementation (Playwright-driven Meet join flow, audio capture
 * via PulseAudio, Hono HTTP control surface, etc.) lands in later PRs of the
 * meet-phase-1 plan. See `meet-bot/README.md` for links.
 *
 * For now this just logs a boot marker and exits cleanly so the Docker image
 * build, the package scripts, and the boot test can all verify the package
 * structure is valid end-to-end.
 */

function main(): void {
  console.log("meet-bot booted");
}

main();
