/**
 * Tests for the mid-stall `/proc` wait-state reader, against a fixture proc
 * tree so they run on any platform. The key behavior: an epoll wait on the
 * daemon's own loop (its set holds the HTTP listening socket) must read
 * differently from a nested synchronous wait (a private set without it).
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  parseEpollTargetFds,
  parseListeningSocketInodes,
  parseProcStat,
  parseProcSyscall,
  readStallWaitState,
} from "../proc-wait-state.js";

const DAEMON = 100;
const EPFD = 7;

let procRoot: string;

function write(path: string, content: string): void {
  const full = join(procRoot, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function fdLink(pid: number, fd: number, target: string): void {
  const dir = join(procRoot, String(pid), "fd");
  mkdirSync(dir, { recursive: true });
  symlinkSync(target, join(dir, String(fd)));
}

/** A `/proc/<pid>/stat` line: state, ppid, and start time in clock ticks. */
function stat(
  pid: number,
  comm: string,
  state: string,
  ppid: number,
  startTicks: number,
): string {
  const fields = [state, ppid, ...Array(17).fill(0), startTicks, 0];
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

/**
 * A daemon whose main thread waits in epoll_wait (x64 syscall 232) on
 * `EPFD`, which watches the given fds.
 */
function daemonWaitingOn(fds: Record<number, string>): void {
  write(
    `${DAEMON}/task/${DAEMON}/syscall`,
    `232 0x${EPFD.toString(16)} 0x7ffd 0x400 0x5 0x0 0x0 0x7ffd 0x7f00\n`,
  );
  write(`${DAEMON}/task/${DAEMON}/stat`, stat(DAEMON, "bun", "S", 1, 500));
  write(`${DAEMON}/task/${DAEMON}/wchan`, "do_epoll_wait");
  write(`${DAEMON}/stat`, stat(DAEMON, "bun", "S", 1, 500));
  write(
    `${DAEMON}/fdinfo/${EPFD}`,
    "pos:\t0\nflags:\t02000002\nmnt_id:\t15\n" +
      Object.keys(fds)
        .map(
          (fd) =>
            `tfd:       ${fd} events:       19 data: 0  pos:0 ino:1 sdev:8\n`,
        )
        .join(""),
  );
  fdLink(DAEMON, EPFD, "anon_inode:[eventpoll]");
  for (const [fd, target] of Object.entries(fds)) {
    fdLink(DAEMON, Number(fd), target);
  }
  // Socket inode 111 listens (state 0A); 222 is an established connection.
  write(
    `${DAEMON}/net/tcp`,
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 111 1 0 100 0 0 10 0\n" +
      "   1: 0100007F:1F40 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 222 1 0 20 4 30 10 -1\n",
  );
  write("uptime", "1000.00 900.00\n");
}

beforeEach(() => {
  procRoot = mkdtempSync(join(tmpdir(), "proc-wait-state-"));
});

afterEach(() => {
  rmSync(procRoot, { recursive: true, force: true });
});

describe("readStallWaitState", () => {
  test("an epoll wait on the daemon's own loop counts the listening socket", () => {
    // GIVEN the waited epoll set holds the HTTP listener plus loop plumbing
    daemonWaitingOn({
      3: "socket:[111]",
      4: "socket:[222]",
      5: "anon_inode:[eventfd]",
      6: "anon_inode:[timerfd]",
    });

    // WHEN the wait state is read
    const state = readStallWaitState(DAEMON, procRoot);

    // THEN the set is attributed to the main loop
    expect(state.syscall).toBe(232);
    expect(state.epoll).toEqual({
      fd: EPFD,
      watched: 4,
      listeningSockets: 1,
      sockets: 2,
      pipes: 0,
      eventfds: 1,
      timerfds: 1,
      other: 0,
    });
  });

  test("a nested synchronous wait has no listening socket and a live child", () => {
    // GIVEN a private epoll set watching only a child's stdout pipe
    daemonWaitingOn({ 9: "pipe:[555]" });
    write("200/stat", stat(200, "git", "R", DAEMON, 97_000)); // started 30s ago
    write("300/stat", stat(300, "unrelated", "S", 1, 1_000));

    // WHEN the wait state is read
    const state = readStallWaitState(DAEMON, procRoot);

    // THEN the wait is visibly not the main loop, and names the child
    expect(state.epoll?.listeningSockets).toBe(0);
    expect(state.epoll?.pipes).toBe(1);
    expect(state.children).toEqual([
      { pid: 200, comm: "git", state: "R", ageMs: 30_000 },
    ]);
  });

  test("groups threads by comm, state and wait channel", () => {
    // GIVEN the main thread plus two idle worker threads in the same futex wait
    daemonWaitingOn({ 3: "socket:[111]" });
    for (const tid of [101, 102]) {
      write(`${DAEMON}/task/${tid}/stat`, stat(tid, "Bun Pool 0", "S", 1, 500));
      write(`${DAEMON}/task/${tid}/wchan`, "futex_wait_queue");
    }

    // WHEN the wait state is read
    const state = readStallWaitState(DAEMON, procRoot);

    // THEN identical threads collapse into one counted group
    expect(state.threads).toContainEqual({
      comm: "Bun Pool 0",
      state: "S",
      wchan: "futex_wait_queue",
      count: 2,
    });
    expect(state.threads).toContainEqual({
      comm: "bun",
      state: "S",
      wchan: "do_epoll_wait",
      count: 1,
    });
  });

  test("a non-epoll wait skips the epoll set", () => {
    // GIVEN the main thread blocked in wait4 on a child (arm64 syscall 260),
    // whose first argument is a pid, not an epoll fd
    write(
      `${DAEMON}/task/${DAEMON}/syscall`,
      "260 0x1b 0x0 0x0 0x0 0x0 0x0 0xffff 0xffff\n",
    );
    fdLink(DAEMON, 0x1b, "pipe:[1]");

    // WHEN the wait state is read
    const state = readStallWaitState(DAEMON, procRoot);

    // THEN only the syscall is reported
    expect(state.syscall).toBe(260);
    expect(state.epoll).toBeNull();
  });

  test("an unreadable /proc yields an empty state, never a throw", () => {
    // GIVEN no proc tree at all (non-Linux, or a permission boundary)
    // WHEN the wait state is read
    const state = readStallWaitState(DAEMON, join(procRoot, "missing"));

    // THEN every field degrades to empty
    expect(state).toEqual({
      syscall: null,
      epoll: null,
      children: [],
      threads: [],
    });
  });
});

describe("parsers", () => {
  test("parseProcStat handles a comm containing spaces and parentheses", () => {
    expect(parseProcStat(stat(5, "Bun (Pool) 1", "D", 4, 42))).toEqual({
      comm: "Bun (Pool) 1",
      state: "D",
      ppid: 4,
      startTicks: 42,
    });
    expect(parseProcStat("garbage")).toBeNull();
  });

  test("parseProcSyscall reads running and numbered forms", () => {
    expect(parseProcSyscall("running\n")).toEqual({ nr: "running", args: [] });
    expect(parseProcSyscall("281 0x1a 0x0\n")).toEqual({
      nr: 281,
      args: [26, 0],
    });
    expect(parseProcSyscall("")).toBeNull();
  });

  test("parseEpollTargetFds and parseListeningSocketInodes", () => {
    expect(
      parseEpollTargetFds("pos:\t0\ntfd:  3 events: 19\ntfd: 12 events: 1\n"),
    ).toEqual([3, 12]);
    const header = "sl local rem st tx rx tr retr uid timeout inode\n";
    expect([
      ...parseListeningSocketInodes(
        `${header}0: a b 0A q:q t:t r 0 0 77 1\n1: a b 01 q:q t:t r 0 0 88 1\n`,
      ),
    ]).toEqual(["77"]);
  });
});
