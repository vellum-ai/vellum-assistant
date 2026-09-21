import type { FileSink } from "bun";

/**
 * Write one line to a worker subprocess's stdin, reporting a broken pipe to
 * `onFailure` however Bun surfaces it.
 *
 * `FileSink.write` and `FileSink.flush` return `number | Promise<number>`.
 * While the pipe has room they complete synchronously. Once a payload outruns
 * the pipe buffer, which is what happens when the worker is busy and not
 * draining stdin, they return a pending promise instead, and that promise
 * rejects with EPIPE if the worker dies before the write completes. A
 * `try/catch` sees only the synchronous half: the rejection escapes it, reaches
 * the process's `unhandledRejection` handler, and in the daemon that handler
 * shuts the whole process down.
 *
 * `onFailure` runs at most once per call, even though `write` and `flush` can
 * each report the same broken pipe.
 */
export function writeWorkerLine(
  stdin: Pick<FileSink, "write" | "flush">,
  line: string,
  onFailure: (err: unknown) => void,
): void {
  let failed = false;
  const fail = (err: unknown): void => {
    if (failed) {
      return;
    }
    failed = true;
    onFailure(err);
  };
  const observe = (result: number | Promise<number>): void => {
    if (result instanceof Promise) {
      result.catch(fail);
    }
  };

  try {
    observe(stdin.write(line + "\n"));
    observe(stdin.flush());
  } catch (err) {
    fail(err);
  }
}
