/**
 * QuickJS-WASM script sandbox for the workflow orchestration engine.
 *
 * Workflow scripts authored by the assistant run here with NO ambient
 * capabilities: no `fetch`, `process`, `Bun`, `require`, no network, no
 * filesystem, no dynamic `import()`. The only way for a script to affect the
 * outside world is through host functions explicitly injected by the caller
 * (later PRs inject `agent()`, `parallel()`, `pipeline()`, etc).
 *
 * Scripts must be deterministic so a later PR can replay them for resume —
 * hence `Date.now`, `Math.random`, and argless `new Date()` are banned and
 * throw {@link WorkflowDeterminismError}. Time and entropy must be passed in
 * via `args`.
 *
 * Host functions may return promises; the async QuickJS variant (asyncify)
 * suspends the VM while the host promise settles and resumes with the result.
 * From the script's perspective host calls are therefore SYNCHRONOUS — authors
 * call `agent(...)` and get the value back directly, no `await`. (Asyncify can
 * only unwind the main eval stack, never a promise continuation, so scripts
 * must stay synchronous; see {@link buildRunner}.)
 */
import singlefileAsyncVariant from "@jitl/quickjs-singlefile-mjs-release-asyncify";
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

import { deterministicStringify } from "./deterministic-stringify.js";

const DEFAULT_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * CPU budget for a single *contiguous* stretch of script execution between host
 * calls. The interrupt handler — invoked periodically by the VM as it executes —
 * returns `true` once this elapses, so a pure `while(true){}` (which never yields
 * to a host call) is interrupted well before the daemon is starved.
 *
 * Crucially this bounds uninterrupted SCRIPT CPU, not total run wall-clock. The
 * deadline is reset around every host-call boundary (see {@link installNativeBridge}),
 * so seconds spent suspended in asyncify awaiting a host promise (each `agent()`
 * leaf is a multi-second LLM round-trip) do NOT count against it. Total-runtime
 * limits are the caller's responsibility via {@link CreateWorkflowSandboxOptions.signal}.
 */
const INTERRUPT_DEADLINE_MS = 5_000;

/**
 * Minimum latency (ms) a host call must have awaited for its time to be excused
 * from the contiguous-CPU {@link INTERRUPT_DEADLINE_MS} guard. The deadline is
 * reset around a host call so a multi-second leaf/agent round-trip (the VM
 * suspended in asyncify) is not counted as script CPU — but ONLY for calls that
 * actually awaited that long. Cheap synchronous host fns (`usage`, `phase`,
 * `log`, `leaf`) return in microseconds; if they reset the deadline too, a tight
 * loop over one (e.g. `while (true) usage()`) would refresh the guard every
 * iteration and pin the run slot burning CPU forever. Sub-threshold calls do not
 * reset, so such a loop trips the CPU guard at {@link INTERRUPT_DEADLINE_MS}.
 */
const HOST_CALL_DEADLINE_RESET_THRESHOLD_MS = 50;

/** Thrown when a script invokes a banned non-deterministic primitive. */
export class WorkflowDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDeterminismError";
  }
}

/** Thrown when the sandboxed script itself throws or rejects. */
export class WorkflowScriptError extends Error {
  /** The QuickJS-side stack trace, when one was available. */
  readonly scriptStack?: string;
  constructor(message: string, scriptStack?: string) {
    super(message);
    this.name = "WorkflowScriptError";
    this.scriptStack = scriptStack;
  }
}

/** Thrown when the script exceeds CPU (interrupt) or memory limits, or is aborted. */
export class WorkflowResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowResourceError";
  }
}

export interface CreateWorkflowSandboxOptions {
  /**
   * Host functions exposed to the script as globals of the same name. Each is
   * called with JSON-marshalled arguments and may return a value or a promise;
   * a returned promise suspends the VM (asyncify) until it settles, so the
   * script observes a synchronous return value.
   */
  hostFunctions: Record<
    string,
    (...args: unknown[]) => unknown | Promise<unknown>
  >;
  /** Receives strings passed to `console.log` / `console.error` inside the VM. */
  onLog?: (msg: string) => void;
  /** Aborts an in-flight run; the VM is interrupted and torn down. */
  signal?: AbortSignal;
  /** Runtime memory ceiling. Defaults to 256 MiB. */
  memoryLimitBytes?: number;
  /**
   * CPU budget, in milliseconds, for a single contiguous stretch of script
   * execution between host calls. Reset around every host-call boundary, so it
   * never counts time suspended awaiting a host promise. Defaults to 5000.
   * Primarily a test seam for exercising the interrupt guard with short delays;
   * production should use the default.
   */
  interruptDeadlineMs?: number;
}

export interface WorkflowSandbox {
  /** Run `scriptSource` (JS or TS) with `args` available as the global `args`. */
  run(scriptSource: string, args: unknown): Promise<unknown>;
}

/**
 * Bootstrap code evaluated in the VM before the user script. It:
 *  - removes/poisons ambient capabilities,
 *  - installs determinism bans,
 *  - wires `console.*` and each host function to the single native bridge
 *    (`__hostCall` for host fns, `__hostLog` for logging).
 *
 * The host-function names are baked in so the script sees real globals (not a
 * proxy) and so typos surface as ReferenceErrors at author time.
 */
function buildBootstrap(hostFunctionNames: string[]): string {
  // Host functions are SYNCHRONOUS wrappers: the native bridge is asyncified,
  // so QuickJS unwinds and resumes the VM stack transparently and `__hostCall`
  // returns the resolved value directly (no VM-side promise). Authors may still
  // write `await agent(...)` — awaiting a non-promise is a harmless no-op.
  const hostFnSetup = hostFunctionNames
    .map((name) => {
      const key = JSON.stringify(name);
      return `globalThis[${key}] = function (...callArgs) {
  const resJson = __hostCall(${key}, JSON.stringify(callArgs));
  return resJson === undefined ? undefined : JSON.parse(resJson);
};`;
    })
    .join("\n");

  return `(() => {
  "use strict";

  const determinismError = (what) => {
    const e = new Error(
      what + " is non-deterministic and banned in workflow scripts. " +
      "Pass timestamps/entropy in via 'args' so runs are reproducible for resume."
    );
    e.name = "WorkflowDeterminismError";
    return e;
  };

  // --- Determinism bans -------------------------------------------------
  Date.now = () => { throw determinismError("Date.now()"); };
  const RealDate = Date;
  const BannedDate = function (...dateArgs) {
    if (dateArgs.length === 0) throw determinismError("new Date()");
    return new RealDate(...dateArgs);
  };
  BannedDate.prototype = RealDate.prototype;
  // Close the constructor escape hatch: the shared prototype's constructor still
  // points at the original Date, so new (Date.prototype.constructor)() -- and
  // someDate.constructor on any instance, since new Date(args) returns a RealDate
  // whose prototype is this same object -- would bypass the new-Date() ban and
  // read wall-clock time. Repoint it at the banned wrapper and lock the slot so a
  // script can neither reach nor restore RealDate (otherwise closure-private).
  // instanceof Date is unaffected because the prototype object itself is unchanged.
  Object.defineProperty(RealDate.prototype, "constructor", {
    value: BannedDate,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  BannedDate.UTC = RealDate.UTC;
  BannedDate.parse = RealDate.parse;
  BannedDate.now = () => { throw determinismError("Date.now()"); };
  globalThis.Date = BannedDate;
  Math.random = () => { throw determinismError("Math.random()"); };

  // --- Strip ambient capabilities --------------------------------------
  // Defensive: most of these never exist in QuickJS, but delete any that
  // a host/intrinsic might surface, and ensure timers are absent.
  for (const cap of [
    "fetch", "XMLHttpRequest", "WebSocket", "process", "Bun", "require",
    "module", "global", "setTimeout", "setInterval", "setImmediate",
    "clearTimeout", "clearInterval", "queueMicrotask", "navigator",
  ]) {
    try { delete globalThis[cap]; } catch (_e) {}
    try {
      Object.defineProperty(globalThis, cap, {
        value: undefined, writable: false, configurable: false,
      });
    } catch (_e) {}
  }

  // --- Logging ----------------------------------------------------------
  const log = (...parts) => {
    try {
      __hostLog(parts.map((p) =>
        typeof p === "string" ? p : JSON.stringify(p)
      ).join(" "));
    } catch (_e) {}
  };
  globalThis.console = { log, error: log, warn: log, info: log, debug: log };

  // --- Host functions ---------------------------------------------------
${hostFnSetup}
})();`;
}

/**
 * The user script body, wrapped in a SYNCHRONOUS function so `args` is in scope
 * and an explicit `return` is supported. Workflow scripts are synchronous: host
 * functions block the script via asyncify (the VM's WASM stack is unwound while
 * the host promise settles, then restored), so authors call `agent(...)` and
 * get the value back directly — no `await`.
 *
 * Asyncify can only suspend the main eval stack, never a promise continuation,
 * so an `async`/`await` script would deadlock on its second host call. A
 * synchronous runner keeps every host call on the eval stack where asyncify
 * works. (`return` returns the value directly; the host reads it from the
 * `evalCodeAsync` result.)
 */
function buildRunner(scriptSource: string): string {
  return `(function () {
  const args = globalThis.__args;
${scriptSource}
})();`;
}

export function createWorkflowSandbox(
  opts: CreateWorkflowSandboxOptions,
): WorkflowSandbox {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const memoryLimitBytes = opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const interruptDeadlineMs = opts.interruptDeadlineMs ?? INTERRUPT_DEADLINE_MS;
  const hostFunctionNames = Object.keys(opts.hostFunctions);

  return {
    async run(scriptSource: string, args: unknown): Promise<unknown> {
      // Wrap first, then transpile, so the author may use top-level `return`
      // and TS syntax inside the synchronous runner. Transpile before spinning
      // up the VM so author TS errors fail cheaply.
      let runnerSource: string;
      try {
        runnerSource = transpiler.transformSync(buildRunner(scriptSource));
      } catch (e) {
        throw new WorkflowScriptError(
          `Failed to transpile workflow script: ${(e as Error).message}`,
        );
      }

      // A fresh WASM module/runtime/context per run is the isolation boundary:
      // no realm, heap, or host-ref state is shared between workflow runs.
      // The context is created via the module-level `newContext()` so the
      // runtime is an *owned lifetime* of the context — disposing the context
      // tears down the runtime in the correct internal order (disposing the
      // runtime separately mis-orders host-ref teardown and aborts the VM).
      // Use the SINGLE-FILE async variant (WASM embedded in the JS module). The
      // default loader fetches a sidecar `emscripten-module.wasm`, which is
      // absent from the compiled daemon's virtual `/$bunfs/` filesystem
      // (`bun build --compile` bundles JS but not the .wasm), so every workflow
      // run aborts with ENOENT. The singlefile variant rides along with the JS
      // bundle and works in source, Docker, and the compiled binary alike.
      const QuickJS = await newQuickJSAsyncWASMModuleFromVariant(
        singlefileAsyncVariant,
      );
      const vm = QuickJS.newContext() as QuickJSAsyncContext;
      const runtime = vm.runtime;
      runtime.setMemoryLimit(memoryLimitBytes);

      // The deadline bounds CONTIGUOUS script CPU between host calls, not total
      // run wall-clock. It is held in a one-element box so the native bridge can
      // reset it around each host-call boundary (where the VM is suspended in
      // asyncify awaiting a host promise — time that must not count against the
      // CPU guard). `signal.aborted` remains the hard, total-runtime stop.
      const deadline = { at: Date.now() + interruptDeadlineMs };
      runtime.setInterruptHandler(() => {
        if (opts.signal?.aborted) return true;
        return Date.now() > deadline.at;
      });

      try {
        installNativeBridge(vm, opts, () => {
          deadline.at = Date.now() + interruptDeadlineMs;
        });
        seedArgs(vm, args);

        // Bootstrap: strip capabilities, install bans, wire host fns.
        const bootstrapResult = await vm.evalCodeAsync(
          buildBootstrap(hostFunctionNames),
          "workflow-bootstrap.js",
        );
        unwrapOrThrow(vm, bootstrapResult).dispose();

        // Evaluating the runner drives all asyncified host calls to completion
        // (asyncify suspends/resumes the VM stack inside evalCodeAsync itself)
        // and returns the script's value directly.
        const evalResult = await vm.evalCodeAsync(
          runnerSource,
          "workflow-script.js",
        );
        using valueHandle = unwrapOrThrow(vm, evalResult);
        return vm.dump(valueHandle);
      } catch (e) {
        rethrowResourceErrorIfAborted(opts.signal, e);
        throw e;
      } finally {
        // Disposing the context disposes its owned runtime too.
        vm.dispose();
      }
    },
  };
}

function installNativeBridge(
  vm: QuickJSAsyncContext,
  opts: CreateWorkflowSandboxOptions,
  resetDeadline: () => void,
): void {
  // Single asyncified bridge for all host functions. Suspends the VM while the
  // host promise settles, then resumes with a JSON string (or undefined).
  const hostCall = vm.newAsyncifiedFunction(
    "__hostCall",
    async (nameHandle, argsJsonHandle) => {
      const name = vm.getString(nameHandle);
      const argsJson = vm.getString(argsJsonHandle);
      const fn = opts.hostFunctions[name];
      if (!fn) {
        // Unreachable from a well-formed script (host names are baked into
        // bootstrap globals), but surface as a VM exception if it ever is.
        throw new Error(`Unknown host function: ${name}`);
      }
      const parsedArgs = JSON.parse(argsJson) as unknown[];
      // A host throw/rejection propagates as a VM exception the script can
      // catch, or — if uncaught — as a WorkflowScriptError to the caller.
      const startedAtMs = Date.now();
      try {
        const result = await fn(...parsedArgs);
        // `undefined` JSON-stringifies to `undefined`; map it to the VM's
        // undefined so the sync wrapper returns `undefined` rather than NaN.
        if (result === undefined) return vm.undefined;
        return vm.newString(deterministicStringify(result));
      } finally {
        // The VM is about to resume script execution. Reset the CPU budget so the
        // (possibly multi-second) host-call latency we just awaited does not count
        // against the interrupt deadline — that guards contiguous script CPU only,
        // not cumulative host-call wall-clock. This runs in `finally` so it
        // resets on a host REJECTION too: when a leaf fails after a multi-second
        // round-trip and the script catches it, the catch/cleanup block must not
        // resume against an already-expired deadline and be killed as a
        // WorkflowResourceError instead of handling the failure. But reset ONLY
        // when the call actually awaited a meaningful amount of time: a cheap
        // synchronous host fn (`usage`/`phase`/`log`/`leaf`) returns in
        // microseconds, and resetting for it would let `while (true) usage()`
        // refresh the deadline every iteration and burn CPU forever. Sub-threshold
        // calls don't reset, so such a loop trips the guard at the deadline.
        // `signal` remains the hard stop.
        if (Date.now() - startedAtMs >= HOST_CALL_DEADLINE_RESET_THRESHOLD_MS) {
          resetDeadline();
        }
      }
    },
  );
  hostCall.consume((handle) => vm.setProp(vm.global, "__hostCall", handle));

  const hostLog = vm.newFunction("__hostLog", (msgHandle) => {
    const msg = vm.getString(msgHandle);
    opts.onLog?.(msg);
  });
  hostLog.consume((handle) => vm.setProp(vm.global, "__hostLog", handle));
}

function seedArgs(vm: QuickJSAsyncContext, args: unknown): void {
  // Embed the args JSON in a parse expression so `__args` is a native VM object
  // (not a host reference) without leaving the raw JSON string on a global.
  const literal = JSON.stringify(deterministicStringify(args));
  const parsed = vm.evalCode(`JSON.parse(${literal})`);
  const handle = unwrapOrThrow(vm, parsed);
  handle.consume((h) => vm.setProp(vm.global, "__args", h));
}

/**
 * Unwrap a QuickJS eval/call result, converting a VM-side error into a typed
 * {@link WorkflowScriptError} (or {@link WorkflowDeterminismError}) with the
 * VM stack attached.
 */
function unwrapOrThrow(
  vm: QuickJSAsyncContext,
  result: { error: QuickJSHandle } | { value: QuickJSHandle } | QuickJSHandle,
): QuickJSHandle {
  // evalCode / evalCodeAsync return a SuccessOrFail; a bare handle is success.
  if (result && typeof result === "object" && "error" in result) {
    const errorHandle = (result as { error: QuickJSHandle }).error;
    try {
      throw vmErrorToTyped(vm, errorHandle);
    } finally {
      errorHandle.dispose();
    }
  }
  if (result && typeof result === "object" && "value" in result) {
    return (result as { value: QuickJSHandle }).value;
  }
  return result as QuickJSHandle;
}

function vmErrorToTyped(
  vm: QuickJSAsyncContext,
  errorHandle: QuickJSHandle,
): Error {
  const dumped = vm.dump(errorHandle) as
    | { name?: string; message?: string; stack?: string }
    | string
    | undefined;

  if (typeof dumped === "string") {
    return new WorkflowScriptError(dumped);
  }
  const name = dumped?.name;
  const message = dumped?.message ?? "Workflow script error";
  const stack = dumped?.stack;

  if (name === "WorkflowDeterminismError") {
    return new WorkflowDeterminismError(message);
  }
  return new WorkflowScriptError(message, stack);
}

function rethrowResourceErrorIfAborted(
  signal: AbortSignal | undefined,
  caught: unknown,
): void {
  // An interrupt (CPU deadline or abort) surfaces as a QuickJS "interrupted"
  // error; normalize it to a typed resource error so callers can distinguish
  // a wedged/aborted script from an author bug.
  const message = caught instanceof Error ? caught.message : String(caught);
  if (signal?.aborted || /interrupt/i.test(message)) {
    throw new WorkflowResourceError(
      signal?.aborted
        ? "Workflow script aborted via signal."
        : "Workflow script exceeded its execution time budget and was interrupted.",
    );
  }
}
