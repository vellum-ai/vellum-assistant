/**
 * Shared test preload — runs before every test file.
 *
 * Mirrors the cli/ package convention. The evals package has no workspace
 * dependencies of its own (yet), but a preload is wired so that future tests
 * which mutate environment can set up + tear down cleanly here.
 */

export {};
