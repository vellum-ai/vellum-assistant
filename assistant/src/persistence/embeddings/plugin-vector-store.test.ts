/**
 * `pluginCollectionName` must be injective on the `(hostId, name)` pair so a
 * plugin can never address another plugin's Qdrant collection.
 *
 * The old `plugin_${hostId}_${name}` form was not injective: `(foo, bar_baz)`
 * and `(foo_bar, baz)` both collapsed to `plugin_foo_bar_baz`, so co-installed
 * plugins could read/overwrite/delete each other's points. The collection name
 * now derives from the shared injective per-plugin prefix (a digest of the raw
 * host id), the same scheme the SQL plugin store uses.
 */
import { describe, expect, test } from "bun:test";

import { pluginNamespacePrefix } from "../plugin-namespace.js";
import { pluginCollectionName } from "./plugin-vector-store.js";

describe("pluginCollectionName", () => {
  test("distinct (host, name) pairs that previously collided are now distinct", () => {
    const a = pluginCollectionName("foo", "bar_baz");
    const b = pluginCollectionName("foo_bar", "baz");

    expect(a).not.toBe(b);
    // Neither maps to the old, non-injective concatenation.
    expect(a).not.toBe("plugin_foo_bar_baz");
    expect(b).not.toBe("plugin_foo_bar_baz");
  });

  test("the collection name is stable across calls for a given (host, name)", () => {
    expect(pluginCollectionName("foo", "bar_baz")).toBe(
      pluginCollectionName("foo", "bar_baz"),
    );
  });

  test("the per-plugin part matches the shared namespace prefix", () => {
    expect(pluginCollectionName("foo", "notes")).toBe(
      `${pluginNamespacePrefix("foo")}notes`,
    );
  });

  test("the collection name stays within Qdrant's [a-z0-9_] alphabet", () => {
    expect(pluginCollectionName("@scope/Plugin-Name", "vec_store")).toMatch(
      /^[a-z0-9_]+$/,
    );
  });
});
