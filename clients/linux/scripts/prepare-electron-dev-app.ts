#!/usr/bin/env bun
/**
 * Linux has no bundle-identifier / Dock cache to patch for the unpackaged
 * Electron binary. The macOS prepare step is a no-op here so the shared
 * `dev` scripts can call the same hook on every desktop client.
 */
console.log("[prepare-electron-dev] nothing to prepare on Linux");
