import { describe, expect, test } from "bun:test";

import { getDefaultPorts } from "../paths.js";
import { SEEDS } from "../seeds.js";

describe("SEEDS port blocks", () => {
  test("production uses the legacy (pre-MVP) port layout", () => {
    const ports = getDefaultPorts(SEEDS.production!);
    expect(ports).toEqual({
      daemon: 7821,
      gateway: 7830,
      qdrant: 6333,
      ces: 8090,
      outboundProxy: 8080,
      tcp: 8765,
    });
  });

  test.each([
    ["staging", 17000],
    ["dev", 18000],
    ["test", 19000],
    ["local", 20000],
  ] as const)("%s block starts at %i with 100-apart services", (name, base) => {
    const ports = getDefaultPorts(SEEDS[name]!);
    expect(ports).toEqual({
      daemon: base,
      gateway: base + 100,
      qdrant: base + 200,
      ces: base + 300,
      outboundProxy: base + 400,
      tcp: base + 500,
    });
  });

  test("non-prod blocks are disjoint across environments", () => {
    // 100 instances per service is the scan headroom in findAvailablePort,
    // so a block "occupies" base…base+599 from daemon through tcp. Verify no
    // two blocks overlap for any service.
    const blocks = (["staging", "dev", "test", "local"] as const).map(
      (name) => ({
        name,
        ports: getDefaultPorts(SEEDS[name]!),
      }),
    );
    const allPorts = new Set<number>();
    for (const { name, ports } of blocks) {
      for (const port of Object.values(ports)) {
        // Within each block, each service has 100 slots (base…base+99).
        for (let offset = 0; offset < 100; offset++) {
          const p = port + offset;
          if (allPorts.has(p)) {
            throw new Error(
              `port ${p} (in ${name}'s block) overlaps another env's block`,
            );
          }
          allPorts.add(p);
        }
      }
    }
  });

  test("non-prod blocks sit below Linux's default ephemeral range (32768)", () => {
    for (const name of ["staging", "dev", "test", "local"] as const) {
      const ports = getDefaultPorts(SEEDS[name]!);
      for (const port of Object.values(ports)) {
        // Max port we'll ever scan to is base+99 for daemon/gateway/etc.
        expect(port + 99).toBeLessThan(32768);
      }
    }
  });
});
