import { mock } from "bun:test";
import { EventEmitter } from "node:events";

/** Fake ChildProcess for spawn-based tests. */
export class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}
