/**
 * Placeholder health probe for the meet-bot container.
 *
 * Invoked by the Dockerfile's HEALTHCHECK directive. Exits 0 to indicate the
 * container is healthy. The real probe (which will hit an in-process `/health`
 * endpoint served by Hono and confirm Playwright/Xvfb/PulseAudio are up)
 * lands in a later PR of the meet-phase-1 plan.
 */

process.exit(0);
