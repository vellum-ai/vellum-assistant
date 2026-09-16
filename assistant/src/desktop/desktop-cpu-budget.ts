import { mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getIsContainerized } from "../config/env-registry.js";
import { getContainerCpuCores } from "../util/cgroup-cpu.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("desktop-cpu-budget");
const CPU_FRACTION = 0.8;
const PERIOD_US = 100_000;
const CGROUP_ROOT = "/sys/fs/cgroup";

export interface DesktopCpuBudget {
  wrapCommand(command: readonly string[]): readonly string[];
}

const UNLIMITED: DesktopCpuBudget = { wrapCommand: (command) => command };

/** Join before exec so Chrome renderers and dock-launched apps inherit the cap. */
export function desktopCpuCommand(
  group: string,
  command: readonly string[],
): readonly string[] {
  return [
    "/bin/sh",
    "-c",
    'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"',
    "desktop-cpu-budget",
    group,
    ...command,
  ];
}

interface BudgetDependencies {
  root: string;
  membership: () => Promise<string>;
  pid: number;
  cores: () => number;
}

async function findOwnCgroup(deps: BudgetDependencies): Promise<string> {
  const entry = (await deps.membership())
    .split("\n")
    .find((line) => line.startsWith("0::"));
  if (!entry) {
    throw new Error("A delegated cgroup v2 CPU controller is required");
  }
  const relativePath = entry.slice(3);
  const nested = resolve(deps.root, `.${relativePath}`);
  if (nested !== deps.root && !nested.startsWith(`${deps.root}/`)) {
    throw new Error("CPU cgroup is outside the visible hierarchy");
  }
  // A cgroup namespace can expose the container at the mount root.
  for (const candidate of new Set([nested, deps.root])) {
    const pids = await readFile(join(candidate, "cgroup.procs"), "utf8").catch(
      () => "",
    );
    if (pids.split(/\s+/).includes(String(deps.pid))) {
      return candidate;
    }
  }
  throw new Error("Cannot locate the assistant's CPU cgroup");
}

/** CPU-only threaded groups leave the assistant in its existing resource domain. */
export async function createDesktopCpuBudget(
  deps: BudgetDependencies = {
    root: CGROUP_ROOT,
    membership: () => readFile("/proc/self/cgroup", "utf8"),
    pid: process.pid,
    cores: getContainerCpuCores,
  },
): Promise<DesktopCpuBudget> {
  const parent = await findOwnCgroup(deps);
  let cores = deps.cores();
  for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
    const raw = await readFile(join(ancestor, "cpu.max"), "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        // The global cgroup root has no bandwidth controller files.
        if (ancestor === deps.root && err.code === "ENOENT") {
          return `max ${PERIOD_US}`;
        }
        throw err;
      },
    );
    const [quota, period] = raw.trim().split(/\s+/);
    if (quota !== "max") {
      const limit = Number(quota) / Number(period);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error("Invalid ancestor CPU quota");
      }
      cores = Math.min(cores, limit);
    }
    if (ancestor === deps.root) {
      break;
    }
  }
  const quota = Math.floor(cores * CPU_FRACTION * PERIOD_US);
  if (!Number.isSafeInteger(quota) || quota < 1_000) {
    throw new Error("Desktop CPU quota is below the kernel minimum or unknown");
  }

  const group = join(parent, "vellum-desktop");
  const parentType = (
    await readFile(join(parent, "cgroup.type"), "utf8")
  ).trim();
  if (!["domain", "domain threaded", "threaded"].includes(parentType)) {
    throw new Error("Desktop CPU parent cgroup has an incompatible type");
  }
  // Threaded conversion can invalidate sibling domain groups, even empty ones.
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "vellum-desktop") {
      continue;
    }
    const type = (
      await readFile(join(parent, entry.name, "cgroup.type"), "utf8")
    ).trim();
    if (type !== "threaded") {
      throw new Error("Desktop CPU cgroup has an incompatible sibling");
    }
  }
  let created = false;
  try {
    try {
      await mkdir(group);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }
    if (created) {
      await writeFile(join(group, "cgroup.type"), "threaded");
    } else if (
      (await readFile(join(group, "cgroup.type"), "utf8")).trim() !== "threaded"
    ) {
      throw new Error("Desktop CPU cgroup has an incompatible type");
    }
    await writeFile(join(parent, "cgroup.subtree_control"), "+cpu");
    await writeFile(join(group, "cpu.max"), `${quota} ${PERIOD_US}`);
    log.info({ group, cores: quota / PERIOD_US }, "Desktop CPU budget enabled");
    return { wrapCommand: (command) => desktopCpuCommand(group, command) };
  } catch (err) {
    if (created) {
      await rmdir(group).catch(() => {});
    }
    throw err;
  }
}

export async function prepareDesktopCpuBudget(): Promise<DesktopCpuBudget> {
  if (process.platform !== "linux" || !getIsContainerized()) {
    return UNLIMITED;
  }
  try {
    return await createDesktopCpuBudget();
  } catch (err) {
    log.warn(
      { err },
      "Desktop CPU cap unavailable; running without CPU isolation",
    );
    return UNLIMITED;
  }
}
