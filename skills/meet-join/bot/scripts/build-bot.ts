#!/usr/bin/env bun
/**
 * build-bot — pre-build the sibling meet-controller-ext package's `dist/` so
 * the bot Dockerfile can `COPY` it into `/app/ext/`.
 *
 * The Dockerfile itself also runs `bun run build` inside the extension
 * source copied into the image. This script exists so local/developer
 * builds (outside Docker) end up with the same `dist/` layout without
 * having to remember the exact sequence.
 */
import { $ } from "bun";

await $`cd ../meet-controller-ext && bun install --frozen-lockfile && bun run build`;
console.log("extension built at ../meet-controller-ext/dist/");
