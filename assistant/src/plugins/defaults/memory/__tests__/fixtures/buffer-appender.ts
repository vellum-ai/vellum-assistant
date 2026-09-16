// Child process for the buffer-file cross-process test: appends `count`
// uniquely tagged entries to `bufferPath` as fast as it can, through the same
// `appendFileSync` call the production appender uses. Hand-formats the entry
// line so the fixture imports nothing from `src/`.
//
// usage: bun buffer-appender.ts <bufferPath> <count> <tag>

import { appendFileSync } from "node:fs";

const [bufferPath, countArg, tag] = process.argv.slice(2);
if (!bufferPath || !countArg || !tag) {
  throw new Error("usage: buffer-appender <bufferPath> <count> <tag>");
}
const count = Number.parseInt(countArg, 10);
for (let i = 0; i < count; i++) {
  appendFileSync(bufferPath, `- [Apr 27, 9:00 AM] ${tag}-${i}\n`, "utf-8");
}
