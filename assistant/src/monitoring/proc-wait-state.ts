/**
 * What a stalled daemon is waiting on, read from `/proc` by the resource
 * monitor mid-stall.
 *
 * The kernel stack alone cannot separate two stalls that look identical in
 * it: the main thread asleep in `epoll_wait` on the daemon's own event loop
 * (a runtime that stopped servicing its timers), and the main thread asleep in
 * a *nested* epoll set that a synchronous call created and waits on. This
 * module reads what tells them apart:
 *
 * - the main thread's blocking syscall (raw number, host-kernel numbering)
 *   and, for an epoll wait, what the waited epoll set watches. The daemon's
 *   loop set contains its HTTP listening socket; a nested set does not.
 * - the daemon's direct children, since a synchronous child wait keeps its
 *   child alive for the length of the stall;
 * - every daemon thread's kernel wait channel.
 *
 * Metadata only: children and threads are named by their kernel `comm` (15
 * bytes, no argv), so no command-line content leaves the machine. Every read
 * is best-effort and yields null or an empty list when `/proc` is missing or
 * unreadable (non-Linux, or a permission boundary).
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/** Caps that keep the capture inside the watchdog telemetry byte budget. */
const MAX_CHILDREN = 5;
const MAX_THREAD_GROUPS = 8;

/** Linux USER_HZ; `/proc/<pid>/stat` times are in these ticks. */
export const CLOCK_TICKS_PER_SECOND = 100;

/** Page sizes Linux kernels use; `/proc` page counts are in one of these. */
const KERNEL_PAGE_SIZES = [4096, 16384, 65536] as const;

/**
 * The kernel page size, which `/proc/<pid>/stat` rss and `statm` counts are
 * in. It varies by kernel (arm64 kernels can use 16 or 64 KiB), so it is
 * derived from this process's own resident size, reported both in kB
 * (`status` VmRSS) and in pages (`statm`). Falls back to 4 KiB.
 */
export function readKernelPageSizeBytes(procRoot = "/proc"): number {
  const status = readText(join(procRoot, "self", "status"));
  const statm = readText(join(procRoot, "self", "statm"));
  const rssKb = status
    ? Number(/^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1])
    : NaN;
  const rssPages = statm ? Number(statm.trim().split(/\s+/)[1]) : NaN;
  if (!(rssKb > 0) || !(rssPages > 0)) {
    return KERNEL_PAGE_SIZES[0];
  }
  const measured = (rssKb * 1024) / rssPages;
  // The two files are read at slightly different moments; snap to the
  // nearest real page size.
  return KERNEL_PAGE_SIZES.reduce((best, size) =>
    Math.abs(Math.log2(size / measured)) < Math.abs(Math.log2(best / measured))
      ? size
      : best,
  );
}

/** What `/proc/<pid>/fd/<n>` links to for an epoll instance. */
const EPOLL_FD_LINK = "anon_inode:[eventpoll]";

/** TCP state code for LISTEN in `/proc/net/tcp{,6}`. */
const TCP_LISTEN_STATE = "0A";

export interface EpollWaitTarget {
  /** The epoll fd the main thread is waiting on. */
  fd: number;
  /** Count of fds registered in that epoll set. */
  watched: number;
  /**
   * Registered sockets that are listening TCP sockets. Non-zero means the
   * waited set is the daemon's own event loop (it holds the HTTP listener);
   * zero means a nested, private wait.
   */
  listeningSockets: number;
  sockets: number;
  pipes: number;
  eventfds: number;
  timerfds: number;
  other: number;
}

export interface StallChildProcess {
  pid: number;
  /** Kernel command name (no arguments). */
  comm: string;
  state: string | null;
  /** How long the child had been running at capture time. */
  ageMs: number | null;
}

export interface StallThreadGroup {
  comm: string;
  state: string | null;
  /** Kernel function the thread sleeps in (`/proc/<pid>/task/<tid>/wchan`). */
  wchan: string | null;
  count: number;
}

export interface StallWaitState {
  /** Main thread's syscall number, "running" when on-CPU, null if unreadable. */
  syscall: number | "running" | null;
  /** Set when the main thread is in an epoll wait and the set is readable. */
  epoll: EpollWaitTarget | null;
  children: StallChildProcess[];
  threads: StallThreadGroup[];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listNumericDirs(path: string): number[] {
  try {
    return readdirSync(path)
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  } catch {
    return [];
  }
}

export interface ProcStat {
  comm: string;
  state: string;
  ppid: number;
  /** User plus system CPU time consumed, in clock ticks. */
  cpuTicks: number;
  /** Start time after boot, in clock ticks. */
  startTicks: number;
  /** Resident set size, in pages. */
  rssPages: number;
}

/** Parse `/proc/<pid>/stat` around the parenthesised comm, which may contain spaces. */
export function parseProcStat(raw: string): ProcStat | null {
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) {
    return null;
  }
  // Fields after the comm start at field 3 (state), so field N is at index
  // N - 3: utime 14, stime 15, starttime 22, rss 24.
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const startTicks = Number(fields[19]);
  const rssPages = Number(fields[21]);
  if (
    !fields[0] ||
    ![ppid, cpuTicks, startTicks, rssPages].every(Number.isFinite)
  ) {
    return null;
  }
  return {
    comm: raw.slice(open + 1, close),
    state: fields[0],
    ppid,
    cpuTicks,
    startTicks,
    rssPages,
  };
}

/**
 * Parse `/proc/<pid>/task/<tid>/syscall`: "running", or the syscall number
 * followed by its arguments in hex.
 */
export function parseProcSyscall(
  raw: string,
): { nr: number | "running"; args: number[] } | null {
  const parts = raw.trim().split(/\s+/);
  if (parts[0] === "running") {
    return { nr: "running", args: [] };
  }
  if (!/^\d+$/.test(parts[0] ?? "")) {
    return null;
  }
  return {
    nr: Number(parts[0]),
    args: parts.slice(1).map((arg) => Number.parseInt(arg, 16)),
  };
}

/** Target fds of an epoll set, from its `/proc/<pid>/fdinfo/<fd>` "tfd:" lines. */
export function parseEpollTargetFds(fdinfo: string): number[] {
  const fds: number[] = [];
  for (const match of fdinfo.matchAll(/^tfd:\s*(\d+)/gm)) {
    fds.push(Number(match[1]));
  }
  return fds;
}

/** Socket inodes in LISTEN state from `/proc/<pid>/net/tcp{,6}` content. */
export function parseListeningSocketInodes(netTcp: string): Set<string> {
  const inodes = new Set<string>();
  for (const line of netTcp.split("\n").slice(1)) {
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
    const cols = line.trim().split(/\s+/);
    if (cols[3] === TCP_LISTEN_STATE && cols[9]) {
      inodes.add(cols[9]);
    }
  }
  return inodes;
}

function readFdLink(procRoot: string, pid: number, fd: number): string | null {
  try {
    return readlinkSync(join(procRoot, String(pid), "fd", String(fd)));
  } catch {
    return null;
  }
}

function readEpollTarget(
  procRoot: string,
  pid: number,
  epfd: number,
): EpollWaitTarget | null {
  const fdinfo = readText(join(procRoot, String(pid), "fdinfo", String(epfd)));
  if (fdinfo == null) {
    return null;
  }
  const listening = new Set<string>();
  for (const file of ["tcp", "tcp6"]) {
    const table = readText(join(procRoot, String(pid), "net", file));
    if (table != null) {
      for (const inode of parseListeningSocketInodes(table)) {
        listening.add(inode);
      }
    }
  }

  const target: EpollWaitTarget = {
    fd: epfd,
    watched: 0,
    listeningSockets: 0,
    sockets: 0,
    pipes: 0,
    eventfds: 0,
    timerfds: 0,
    other: 0,
  };
  for (const fd of parseEpollTargetFds(fdinfo)) {
    target.watched++;
    const link = readFdLink(procRoot, pid, fd);
    if (link == null) {
      target.other++;
      continue;
    }
    const socket = /^socket:\[(\d+)\]$/.exec(link);
    if (socket) {
      target.sockets++;
      if (listening.has(socket[1]!)) {
        target.listeningSockets++;
      }
    } else if (link.startsWith("pipe:")) {
      target.pipes++;
    } else if (link === "anon_inode:[eventfd]") {
      target.eventfds++;
    } else if (link === "anon_inode:[timerfd]") {
      target.timerfds++;
    } else {
      target.other++;
    }
  }
  return target;
}

function readChildren(procRoot: string, pid: number): StallChildProcess[] {
  const uptimeRaw = readText(join(procRoot, "uptime"));
  const uptimeMs =
    uptimeRaw != null ? Number(uptimeRaw.split(/\s+/)[0]) * 1000 : NaN;
  const children: StallChildProcess[] = [];
  for (const candidate of listNumericDirs(procRoot)) {
    const stat = readText(join(procRoot, String(candidate), "stat"));
    const parsed = stat != null ? parseProcStat(stat) : null;
    if (parsed == null || parsed.ppid !== pid) {
      continue;
    }
    const startedMs = (parsed.startTicks / CLOCK_TICKS_PER_SECOND) * 1000;
    children.push({
      pid: candidate,
      comm: parsed.comm,
      state: parsed.state,
      ageMs: Number.isFinite(uptimeMs)
        ? Math.max(0, Math.round(uptimeMs - startedMs))
        : null,
    });
  }
  // Youngest first: a child spawned for the stalled call is the newest one.
  children.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));
  return children.slice(0, MAX_CHILDREN);
}

function readThreadGroups(procRoot: string, pid: number): StallThreadGroup[] {
  const groups = new Map<string, StallThreadGroup>();
  for (const tid of listNumericDirs(join(procRoot, String(pid), "task"))) {
    const taskDir = join(procRoot, String(pid), "task", String(tid));
    const stat = readText(join(taskDir, "stat"));
    const parsed = stat != null ? parseProcStat(stat) : null;
    const wchanRaw = readText(join(taskDir, "wchan"))?.trim();
    const group = {
      comm: parsed?.comm ?? "?",
      state: parsed?.state ?? null,
      // "0" means the thread is not sleeping in the kernel.
      wchan: wchanRaw && wchanRaw !== "0" ? wchanRaw : null,
    };
    const key = `${group.comm}\0${group.state}\0${group.wchan}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, { ...group, count: 1 });
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_THREAD_GROUPS);
}

/**
 * Read what the process `pid` is waiting on. `procRoot` is injectable so
 * tests can run against a fixture tree on any platform.
 */
export function readStallWaitState(
  pid: number,
  procRoot = "/proc",
): StallWaitState {
  // The main thread's tid equals the pid.
  const syscallRaw = readText(
    join(procRoot, String(pid), "task", String(pid), "syscall"),
  );
  const syscall = syscallRaw != null ? parseProcSyscall(syscallRaw) : null;

  // An epoll wait is recognised by its first argument being an epoll fd, not
  // by syscall number: the numbers differ per architecture, and an emulated
  // process reports the host kernel's numbering.
  let epoll: EpollWaitTarget | null = null;
  const firstArg = syscall?.args[0];
  if (
    firstArg !== undefined &&
    Number.isInteger(firstArg) &&
    readFdLink(procRoot, pid, firstArg) === EPOLL_FD_LINK
  ) {
    epoll = readEpollTarget(procRoot, pid, firstArg);
  }

  return {
    syscall: syscall?.nr ?? null,
    epoll,
    children: readChildren(procRoot, pid),
    threads: readThreadGroups(procRoot, pid),
  };
}
