/** Fixture builders for tests that read a fake `/proc` tree. */

/** A `/proc/<pid>/stat` line; times in clock ticks, rss in pages. */
export function stat(
  pid: number,
  comm: string,
  state: string,
  ppid: number,
  startTicks: number,
  usage: { utime?: number; stime?: number; rssPages?: number } = {},
): string {
  // Fields 3..24: state ppid pgrp session tty tpgid flags minflt cminflt
  // majflt cmajflt utime stime cutime cstime priority nice threads
  // itrealvalue starttime vsize rss, then rsslim.
  const fields = [
    state,
    ppid,
    ...Array(9).fill(0),
    usage.utime ?? 0,
    usage.stime ?? 0,
    ...Array(6).fill(0),
    startTicks,
    0,
    usage.rssPages ?? 0,
    0,
  ];
  return `${pid} (${comm}) ${fields.join(" ")}\n`;
}
