import { describe, expect, mock, test } from "bun:test";

import { logCesLine } from "./process-manager.js";

function makeLogger() {
  return {
    debug: mock((_obj: object, _msg: string) => {}),
    info: mock((_obj: object, _msg: string) => {}),
    warn: mock((_obj: object, _msg: string) => {}),
    error: mock((_obj: object, _msg: string) => {}),
  };
}

describe("logCesLine", () => {
  test("pino JSON INFO line routes to log.info (not log.error)", () => {
    const logger = makeLogger();
    const line = JSON.stringify({
      level: 30,
      msg: "CES ready",
      time: Date.now(),
    });

    logCesLine(line, 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();

    const [meta, msg] = logger.info.mock.calls[0] as [object, string];
    expect(meta).toEqual({ pid: 42 });
    expect(msg).toBe(`[ces-stderr] ${line}`);
  });

  test("pino JSON ERROR line routes to log.error", () => {
    const logger = makeLogger();
    const line = JSON.stringify({
      level: 50,
      msg: "credential store failed",
      time: Date.now(),
    });

    logCesLine(line, 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("non-JSON fragment like 'args: []' routes to log.info", () => {
    const logger = makeLogger();

    logCesLine("args: []", 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();

    const [meta, msg] = logger.info.mock.calls[0] as [object, string];
    expect(meta).toEqual({ pid: 42 });
    expect(msg).toBe("[ces-stderr] args: []");
  });

  test("non-JSON line starting with 'ERROR:' routes to log.error", () => {
    const logger = makeLogger();

    logCesLine("ERROR: bad thing happened", 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped ERROR line routes to log.error", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] ERROR oh no", 42, logger);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped WARN line routes to log.warn", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] WARN wat", 42, logger);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });

  test("pino-pretty timestamped INFO line routes to log.info", () => {
    const logger = makeLogger();

    logCesLine("[12:07:37.467] INFO starting", 42, logger);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
