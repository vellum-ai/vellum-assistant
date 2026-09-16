import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  createDesktopCpuBudget,
  desktopCpuCommand,
} from "./desktop-cpu-budget.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function hierarchy() {
  const root = await mkdtemp(join(tmpdir(), "desktop-cpu-"));
  directories.push(root);
  const parent = join(root, "container");
  await mkdir(parent);
  await writeFile(join(root, "cgroup.type"), "domain");
  await writeFile(join(parent, "cgroup.type"), "domain");
  await writeFile(join(root, "cgroup.procs"), "1\n");
  await writeFile(join(parent, "cgroup.procs"), `${process.pid}\n`);
  await writeFile(join(root, "cpu.max"), "200000 100000");
  await writeFile(join(parent, "cpu.max"), "max 100000");
  return {
    root,
    parent,
    deps: {
      root,
      membership: async () => "0::/container\n",
      pid: process.pid,
      cores: () => 8,
    },
  };
}

test("uses the tightest visible ancestor quota and shares one budget across launches and restarts", async () => {
  const h = await hierarchy();
  const budget = await createDesktopCpuBudget(h.deps);
  const group = join(h.parent, "vellum-desktop");
  expect(await readFile(join(group, "cpu.max"), "utf8")).toBe("160000 100000");
  expect(budget.wrapCommand(["chrome"])[4]).toBe(group);
  expect(budget.wrapCommand(["Xvnc"])[4]).toBe(group);
  // A resized parent must update the existing group before its next launch.
  await writeFile(join(h.parent, "cpu.max"), "50000 100000");
  const restarted = await createDesktopCpuBudget(h.deps);
  expect(restarted.wrapCommand(["chrome"])[4]).toBe(group);
  expect(await readFile(join(group, "cpu.max"), "utf8")).toBe("40000 100000");
  expect(await readFile(join(h.parent, "cgroup.procs"), "utf8")).toBe(
    `${process.pid}\n`,
  );
});

test("resolves namespace-root membership and honors a smaller platform CPU allocation", async () => {
  const h = await hierarchy();
  await writeFile(join(h.root, "cgroup.procs"), `${process.pid}\n`);
  await rm(h.parent, { recursive: true });
  const budget = await createDesktopCpuBudget({
    ...h.deps,
    membership: async () => "0::/hidden/container\n",
    cores: () => 0.5,
  });
  const group = join(h.root, "vellum-desktop");
  expect(budget.wrapCommand(["chrome"])[4]).toBe(group);
  expect(await readFile(join(group, "cpu.max"), "utf8")).toBe("40000 100000");
});

test("refuses to modify a hierarchy that does not contain the assistant", async () => {
  const h = await hierarchy();
  await expect(createDesktopCpuBudget({ ...h.deps, pid: -1 })).rejects.toThrow(
    "Cannot locate",
  );
  await expect(
    readFile(join(h.parent, "cgroup.subtree_control")),
  ).rejects.toThrow();
});

test("handles a global hierarchy root without cpu.max", async () => {
  const h = await hierarchy();
  await rm(join(h.root, "cpu.max"));
  await writeFile(join(h.parent, "cpu.max"), "250000 100000");
  const budget = await createDesktopCpuBudget(h.deps);
  expect(budget.wrapCommand(["chrome"])[4]).toBe(
    join(h.parent, "vellum-desktop"),
  );
});

test("propagates unavailable CPU delegation instead of returning an unenforced launcher", async () => {
  const h = await hierarchy();
  await symlink(h.root, join(h.parent, "cgroup.subtree_control"));
  await expect(createDesktopCpuBudget(h.deps)).rejects.toThrow();
  await expect(
    readFile(join(h.parent, "vellum-desktop", "cpu.max")),
  ).rejects.toThrow();
});

test("does not repurpose an existing domain group", async () => {
  const h = await hierarchy();
  const group = join(h.parent, "vellum-desktop");
  await mkdir(group);
  await writeFile(join(group, "cgroup.type"), "domain");
  await expect(createDesktopCpuBudget(h.deps)).rejects.toThrow(
    "incompatible type",
  );
  expect(await readFile(join(group, "cgroup.type"), "utf8")).toBe("domain");
  await expect(
    readFile(join(h.parent, "cgroup.subtree_control")),
  ).rejects.toThrow();
});

test("launcher joins before exec, preserves its PID, and passes arguments literally", async () => {
  const h = await hierarchy();
  const argument = 'literal $(exit 99) "quoted"';
  const child = Bun.spawn(
    [
      ...desktopCpuCommand(h.parent, [
        "/bin/sh",
        "-c",
        'printf "%s\\n%s\\n" "$$" "$1"',
        "child",
        argument,
      ]),
    ],
    { stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe(
    `${child.pid}\n${argument}\n`,
  );
  expect(await readFile(join(h.parent, "cgroup.procs"), "utf8")).toBe(
    `${child.pid}\n`,
  );
});

test("launcher never executes the desktop command if joining fails", async () => {
  const h = await hierarchy();
  const child = Bun.spawn(
    [
      ...desktopCpuCommand(join(h.root, "missing"), [
        "/bin/sh",
        "-c",
        'printf "started"',
      ]),
    ],
    { stdout: "pipe", stderr: "ignore", windowsHide: true },
  );
  expect(await child.exited).toBe(125);
  expect(await new Response(child.stdout).text()).toBe("");
});

for (const siblingType of ["domain", "domain invalid", "domain threaded"]) {
  test(`refuses a ${siblingType} sibling before modifying the hierarchy`, async () => {
    const h = await hierarchy();
    const sibling = join(h.parent, "worker");
    await mkdir(sibling);
    await writeFile(join(sibling, "cgroup.type"), siblingType);
    await writeFile(join(sibling, "cgroup.procs"), "");
    await expect(createDesktopCpuBudget(h.deps)).rejects.toThrow(
      "incompatible sibling",
    );
    expect(await readFile(join(sibling, "cgroup.type"), "utf8")).toBe(
      siblingType,
    );
    expect(await readFile(join(h.parent, "cgroup.type"), "utf8")).toBe(
      "domain",
    );
    await expect(
      readFile(join(h.parent, "vellum-desktop", "cgroup.type")),
    ).rejects.toThrow();
    await expect(
      readFile(join(h.parent, "cgroup.subtree_control")),
    ).rejects.toThrow();
  });
}

test("refuses an invalid parent before creating a desktop group", async () => {
  const h = await hierarchy();
  await writeFile(join(h.parent, "cgroup.type"), "domain invalid");
  await expect(createDesktopCpuBudget(h.deps)).rejects.toThrow(
    "parent cgroup has an incompatible type",
  );
  await expect(
    readFile(join(h.parent, "vellum-desktop", "cgroup.type")),
  ).rejects.toThrow();
});

test("joins an existing threaded hierarchy without altering its sibling", async () => {
  const h = await hierarchy();
  await writeFile(join(h.parent, "cgroup.type"), "domain threaded");
  const sibling = join(h.parent, "worker");
  await mkdir(sibling);
  await writeFile(join(sibling, "cgroup.type"), "threaded");
  await writeFile(join(sibling, "cgroup.procs"), "123");
  const budget = await createDesktopCpuBudget(h.deps);
  expect(budget.wrapCommand(["chrome"])[4]).toBe(
    join(h.parent, "vellum-desktop"),
  );
  expect(await readFile(join(sibling, "cgroup.procs"), "utf8")).toBe("123");
  expect(await readFile(join(sibling, "cgroup.type"), "utf8")).toBe("threaded");
});
