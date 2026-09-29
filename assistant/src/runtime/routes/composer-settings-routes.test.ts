import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { ComposerPreferencesSchema } from "../../config/composer-preferences.js";

const preferences = new Map<
  string,
  ReturnType<typeof ComposerPreferencesSchema.parse>
>();
const resolvePrincipal = mock(async (id?: string) => id);
const publish = mock(async (_tags: string[], _origin?: string) => {});
mock.module("../local-actor-identity.js", () => ({
  resolveActorPrincipalIdForLocalGuardian: resolvePrincipal,
}));
mock.module("../sync/sync-publisher.js", () => ({
  publishSyncInvalidation: publish,
}));
mock.module("../../config/composer-preferences.js", () => ({
  readComposerPreferences: (id: string) =>
    preferences.get(id) ?? ComposerPreferencesSchema.parse({}),
  updateComposerPreferences: (id: string, patch: object) => {
    const value = ComposerPreferencesSchema.parse({
      ...preferences.get(id),
      ...patch,
    });
    preferences.set(id, value);
    return value;
  },
}));
const { ROUTES } = await import("./composer-settings-routes.js");
const get = ROUTES.find((route) => route.method === "GET")!;
const patch = ROUTES.find((route) => route.method === "PATCH")!;
beforeEach(() => {
  preferences.clear();
  resolvePrincipal.mockClear();
  publish.mockClear();
});
afterEach(() => {
  mock.restore();
});
test("uses the caller identity and emits value-free invalidation after saving", async () => {
  await patch.handler({
    headers: {
      "x-vellum-actor-principal-id": "user-1",
      "x-vellum-client-id": "client-1",
    },
    body: { lastAutonomy: "low" },
  });
  expect(preferences.get("user-1")?.lastAutonomy).toBe("low");
  expect(publish).toHaveBeenCalledWith(
    ["assistant:self:composerPreferences"],
    "client-1",
  );
  const result = await get.handler({
    headers: { "x-vellum-actor-principal-id": "user-2" },
  });
  expect(result).toMatchObject({ preferences: { lastAutonomy: null } });
});
test("refuses preferences with no resolved identity", async () => {
  await expect(get.handler({})).rejects.toThrow("signed-in user");
  expect(publish).not.toHaveBeenCalled();
});
test("the body cannot select another user's preferences", async () => {
  await expect(
    patch.handler({
      headers: { "x-vellum-actor-principal-id": "user-1" },
      body: { principalId: "user-2", lastModeId: "balanced" },
    }),
  ).rejects.toThrow();
  expect(preferences.size).toBe(0);
  expect(publish).not.toHaveBeenCalled();
});
