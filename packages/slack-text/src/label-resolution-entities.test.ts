import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import {
  buildSlackChannelLabelMap,
  buildSlackUserLabelMap,
  renderSlackTextForModel,
} from "./index.js";

describe("Slack embedded-label lookup parity", () => {
  const cases = [
    { id: "U123", prefix: "@", build: buildSlackUserLabelMap, mapKey: "userLabels" },
    {
      id: "C123",
      prefix: "#",
      build: buildSlackChannelLabelMap,
      mapKey: "channelLabels",
    },
  ] as const;

  for (const { id, prefix, build, mapKey } of cases) {
    for (const label of ["&lt;&gt;", `&lt;${id}&gt;`, "&lt; @# &gt;"]) {
      test(`${prefix} resolves label ${label} after Slack entity decoding`, async () => {
        const text = `<${prefix}${id}|${label}>`;
        const requested: string[] = [];
        const labels = await build([text], async (value) => {
          requested.push(value);
          return "Example Name";
        });
        assert.deepEqual(requested, [id]);
        assert.equal(
          renderSlackTextForModel(text, { [mapKey]: labels }),
          `${prefix}Example Name`,
        );
      });
    }

    for (const label of ["&lt;Example&gt;", "R&amp;D", "&amp;lt;&amp;gt;"]) {
      test(`${prefix} keeps usable embedded label ${label} without lookup`, async () => {
        const requested: string[] = [];
        const text = `<${prefix}${id}|${label}>`;
        const labels = await build([text], async (value) => {
          requested.push(value);
          return "Wrong Label";
        });
        assert.deepEqual(requested, []);
        assert.deepEqual(labels, {});
        const expected =
          label === "&lt;Example&gt;"
            ? "Example"
            : label === "R&amp;D"
              ? "R&D"
              : "&lt;&gt;";
        assert.equal(
          renderSlackTextForModel(text, { [mapKey]: labels }),
          `${prefix}${expected}`,
        );
      });
    }

    test(`${prefix} deduplicates required lookups across encoded and bare mentions`, async () => {
      const requested: string[] = [];
      const labels = await build(
        [`<${prefix}${id}|&lt;&gt;>`, `<${prefix}${id}>`],
        async (value) => {
          requested.push(value);
          return "Example";
        },
      );
      assert.deepEqual(requested, [id]);
      assert.deepEqual(labels, { [id]: "Example" });
    });

    test(`${prefix} does not decode caller-resolved entity text`, async () => {
      const text = `<${prefix}${id}|&lt;&gt;>`;
      const labels = await build([text], async () => "&lt;Example&gt;");
      assert.equal(
        renderSlackTextForModel(text, { [mapKey]: labels }),
        `${prefix}&lt;Example&gt;`,
      );
    });

    test(`${prefix} preserves unknown fallback after a failed required lookup`, async () => {
      let attempts = 0;
      const text = `<${prefix}${id}|&lt;&gt;>`;
      const labels = await build([text], async () => {
        attempts++;
        throw new Error("unavailable");
      });
      assert.equal(attempts, 1);
      assert.deepEqual(labels, {});
      const expected = prefix === "@" ? "@unknown-user" : "#unknown-channel";
      assert.equal(renderSlackTextForModel(text, { [mapKey]: labels }), expected);
    });
  }
});
