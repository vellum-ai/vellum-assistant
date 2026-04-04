#!/usr/bin/env bun
/**
 * docker-login-with-retry.ts — Retry Docker Hub login with configurable
 * attempts and backoff.
 *
 * Required environment variables:
 *   DOCKERHUB_USER            — Docker Hub username
 *   DOCKERHUB_ACCESS_TOKEN    — Docker Hub access token / password
 *
 * Optional environment variables:
 *   MAX_ATTEMPTS              — Number of login attempts (default: 3)
 *   RETRY_WAIT_SECONDS        — Seconds to wait between retries (default: 10)
 */

import { execSync } from "node:child_process";

const DOCKERHUB_USER = process.env.DOCKERHUB_USER;
const DOCKERHUB_ACCESS_TOKEN = process.env.DOCKERHUB_ACCESS_TOKEN;

if (!DOCKERHUB_USER || !DOCKERHUB_ACCESS_TOKEN) {
  console.error(
    "ERROR: DOCKERHUB_USER and DOCKERHUB_ACCESS_TOKEN must be set"
  );
  process.exit(1);
}

const maxAttempts = parseInt(process.env.MAX_ATTEMPTS ?? "3", 10);
const retryWaitSeconds = parseInt(process.env.RETRY_WAIT_SECONDS ?? "10", 10);

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  console.log(`Docker Hub login attempt ${attempt}/${maxAttempts}...`);
  try {
    execSync(
      `echo "$DOCKERHUB_ACCESS_TOKEN" | docker login -u "$DOCKERHUB_USER" --password-stdin`,
      { stdio: "inherit", env: process.env }
    );
    console.log(`Docker Hub login succeeded on attempt ${attempt}`);
    process.exit(0);
  } catch {
    if (attempt < maxAttempts) {
      console.log(`Login failed, retrying in ${retryWaitSeconds}s...`);
      execSync(`sleep ${retryWaitSeconds}`);
    }
  }
}

console.error(`ERROR: Docker Hub login failed after ${maxAttempts} attempts`);
process.exit(1);
