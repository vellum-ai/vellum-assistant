import { assertSuccess, type CommandRunner } from "../runtime/command-runner";
import type { SeededConversationMessage } from "../setup-command";

/**
 * Hermes session seeding — direct SQLite injection into the running
 * container's `state.db`.
 *
 * ## Why direct DB writes
 *
 * The eval contract (`runSetupCommand({ type: "seed-conversation", ... })`)
 * requires conversation history to land BEFORE the agent's first turn,
 * **without invoking the model** to "replay" it. Hermes ships no CLI or
 * gateway endpoint that imports history non-interactively — the available
 * `hermes sessions` subcommands are read-only (list / browse / export /
 * delete / prune / stats / rename) and the OpenAI-compatible gateway is
 * stateless. The only honest way to fulfill the contract is to write the
 * session and messages straight into the store Hermes reads from.
 *
 * ## Where the data lives
 *
 * The Hermes Docker image sets `HERMES_HOME=/opt/data` (verified against
 * NousResearch/hermes-agent's Dockerfile), so the SQLite state DB is at
 * `/opt/data/state.db`. Tables relevant to seeding:
 *
 *   - `sessions(id TEXT PK, source TEXT NOT NULL, started_at REAL NOT NULL,
 *      message_count INTEGER, title TEXT, ...)`
 *   - `messages(id INTEGER PK AUTOINCREMENT, session_id TEXT NOT NULL,
 *      role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, ...)`
 *
 * The `messages_fts` and `messages_fts_trigram` virtual tables are
 * auto-populated by triggers on INSERT INTO messages, so we don't touch
 * them. WAL mode is in effect, so concurrent reads from the Hermes
 * runtime are safe; writes acquire the WAL write lock briefly.
 *
 * ## Why Python (not sqlite3 CLI)
 *
 * `apt-get` in the Hermes Dockerfile does not install `sqlite3` — but
 * Python 3 is mandatory (it's how Hermes itself runs), and Python's
 * stdlib ships `sqlite3` everywhere. Driving a small Python helper via
 * `docker exec -i ... python3 -c <script>` lets us use real
 * parameterized inserts (no SQL-injection risk from message content),
 * bind WAL-friendly pragmas, and read structured stdout for diagnostics.
 *
 * ## How the script reaches Python
 *
 * The script body is passed as a single argv element to `python3 -c`.
 * Stdin is reserved for the JSON payload (`db_path`, `session_id`,
 * `source`, `title`, `messages`). The previous iteration used
 * `python3 -` and concatenated `SCRIPT + "\n" + PAYLOAD` on stdin — that
 * was wrong: `python3 -` reads stdin to EOF as the program body, then
 * `json.load(sys.stdin)` saw EOF and raised `JSONDecodeError("Expecting
 * value: line 1 column 1 (char 0)")`. Splitting the two channels —
 * `-c` for code, stdin for data — fixes the failure mode cleanly and
 * keeps shell-escaping out of the loop entirely (`spawn` passes argv
 * directly to `execvp`, no shell).
 *
 * ## Concurrency
 *
 * The Hermes daemon may hold the WAL write lock briefly while writing
 * its own session telemetry. The seed helper uses `BEGIN IMMEDIATE` with
 * Python's default `timeout=5` to wait through transient locks, mirroring
 * Hermes' own `SessionDB._execute_write` discipline. We don't retry past
 * the timeout — by hatch time the daemon should be quiet and a 5s wait
 * is generous.
 *
 * ## Who creates and owns state.db
 *
 * The gateway is the sole creator and owner of `state.db`. It runs as the
 * unprivileged `hermes` user and lazily builds the `sessions`/`messages`
 * schema only after it finishes syncing its bundled skills at startup
 * (~10-15s). Two rules keep seeding from corrupting that:
 *
 *   1. **The schema-wait probe is read-only** (`file:<path>?mode=ro`). A
 *      read-write connect would *create* `state.db` if absent — and since
 *      `docker exec` runs as root, that root-owned file blocks the
 *      `hermes`-user gateway from writing its schema (`attempt to write a
 *      readonly database`), so the gateway silently falls back to JSONL
 *      and the tables never appear. Probing read-only lets the gateway
 *      stay the sole creator; we only open read-write once the tables it
 *      created are visible.
 *   2. **The seed `docker exec` runs as `--user hermes`**, so the write
 *      (and the WAL/SHM sidecar files SQLite creates next to the DB) are
 *      owned by the gateway's user, never root — symmetric protection so
 *      the gateway's own subsequent writes never hit a root-owned file.
 *
 * @see ../adapter.ts  AdapterTestSetupCommand contract.
 * @see https://github.com/NousResearch/hermes-agent/blob/main/hermes_state.py  Upstream schema.
 */

/** In-container path to the Hermes SQLite state DB. */
export const HERMES_STATE_DB_PATH = "/opt/data/state.db";

/** `source` value written into `sessions.source` for evals seeds. */
export const HERMES_EVAL_SESSION_SOURCE = "evals";

/** Title prefix written into `sessions.title` for traceability in `hermes sessions list`. */
export const HERMES_EVAL_SESSION_TITLE_PREFIX = "evals seed";
/**
 * How long the seed waits for the gateway to create the session schema.
 * The gateway only builds it after syncing ~87 bundled skills at startup
 * (observed ready at ~12s); 30s leaves headroom for slower cold starts.
 */
export const HERMES_SCHEMA_WAIT_TIMEOUT_SECONDS = 30;
/**
 * Unprivileged user the Hermes gateway runs as. The seed `docker exec`
 * runs as this user (not the default root) so state.db and its WAL/SHM
 * files stay gateway-owned. @see the "Who creates and owns state.db" note.
 */
export const HERMES_RUNTIME_USER = "hermes";

export interface SeedHermesSessionInput {
  runner: CommandRunner;
  containerName: string;
  /** ID assigned to the new `sessions` row. Must be unique across the run. */
  sessionId: string;
  messages: ReadonlyArray<SeededConversationMessage>;
  /** Optional human-readable test label; ends up appended to the session title. */
  testLabel?: string;
  /** Override the container path to the state DB (test seam). */
  stateDbPath?: string;
  /** Override the in-container python3 binary path (test seam). */
  pythonBinary?: string;
  /** Override the user the seed exec runs as (test seam). */
  runtimeUser?: string;
}

/**
 * Inline Python helper executed inside the container via `docker exec -i
 * python3 -`. Reads `{db_path, session_id, source, title, messages}`
 * from stdin as JSON, opens `state.db`, and writes one `sessions` row +
 * one `messages` row per seeded message in a single transaction.
 *
 * Kept as a string constant so it stays close to the schema docs above
 * and prettier/eslint don't try to parse it.
 */
const SEED_PYTHON_SCRIPT = `
import json, sqlite3, sys, time

payload = json.load(sys.stdin)
db_path = payload["db_path"]
session_id = payload["session_id"]
source = payload["source"]
title = payload["title"]
messages = payload["messages"]
schema_wait_timeout_seconds = payload["schema_wait_timeout_seconds"]

# Wait for the gateway to create the session schema, probing READ-ONLY via
# a file: URI so this check never creates state.db itself. A read-write
# connect would create the file as root (docker exec runs as root), which
# blocks the unprivileged hermes-user gateway from writing its schema and
# silently drops it to JSONL. See the "Who creates and owns state.db" note.
required = {"sessions", "messages"}
deadline = time.time() + schema_wait_timeout_seconds
while True:
    tables = set()
    try:
        probe = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
        try:
            tables = {
                row[0]
                for row in probe.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions', 'messages')"
                )
            }
        finally:
            probe.close()
    except sqlite3.OperationalError:
        # state.db not created by the gateway yet — keep waiting.
        tables = set()
    if required.issubset(tables):
        break
    if time.time() >= deadline:
        raise sqlite3.OperationalError(
            "Hermes state DB schema not ready after "
            + str(schema_wait_timeout_seconds)
            + "s: missing "
            + ",".join(sorted(required - tables))
        )
    time.sleep(0.25)

# timeout=5 lets us wait through transient WAL write locks held by the
# Hermes daemon. isolation_level=None puts us in autocommit so the
# explicit BEGIN IMMEDIATE below acquires the write lock at txn start
# (matching upstream SessionDB._execute_write discipline).
conn = sqlite3.connect(db_path, timeout=5, isolation_level=None)
try:
    conn.execute("PRAGMA foreign_keys=ON")
    now = time.time()
    conn.execute("BEGIN IMMEDIATE")
    try:
        # INSERT OR IGNORE matches upstream _insert_session_row so a
        # retry-after-partial-failure stays idempotent.
        conn.execute(
            "INSERT OR IGNORE INTO sessions "
            "(id, source, started_at, message_count, title) "
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, source, now, len(messages), title),
        )
        # Sub-millisecond increments preserve ordering for the
        # ORDER BY timestamp index reads upstream uses (idx_messages_session).
        for index, message in enumerate(messages):
            conn.execute(
                "INSERT INTO messages (session_id, role, content, timestamp) "
                "VALUES (?, ?, ?, ?)",
                (session_id, message["role"], message["content"], now + index * 0.001),
            )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
finally:
    conn.close()

# Caller parses this line to confirm row counts.
print(json.dumps({"session_id": session_id, "messages": len(messages)}))
`.trim();

/**
 * Seed a Hermes session by writing rows directly into the running
 * container's `state.db`. Returns the `sessions.id` written so the
 * caller can route subsequent `hermes message` / `hermes events` calls
 * at it via `--conversation-key`.
 *
 * Throws when the underlying `docker exec python3 -` fails (e.g. the
 * container is gone, state.db is locked past 5s, or the schema diverged
 * from what the helper expects). The error preserves the container's
 * Python traceback in the message so misalignment with a future Hermes
 * schema version is obvious in the eval log.
 */
export async function seedHermesSession({
  runner,
  containerName,
  sessionId,
  messages,
  testLabel,
  stateDbPath = HERMES_STATE_DB_PATH,
  pythonBinary = "python3",
  runtimeUser = HERMES_RUNTIME_USER,
}: SeedHermesSessionInput): Promise<{ sessionId: string }> {
  const title = testLabel
    ? `${HERMES_EVAL_SESSION_TITLE_PREFIX}: ${testLabel}`
    : HERMES_EVAL_SESSION_TITLE_PREFIX;

  const payload = JSON.stringify({
    db_path: stateDbPath,
    session_id: sessionId,
    source: HERMES_EVAL_SESSION_SOURCE,
    title,
    schema_wait_timeout_seconds: HERMES_SCHEMA_WAIT_TIMEOUT_SECONDS,
    // Re-shape messages to a plain {role, content} dict so the inline
    // Python doesn't need to know about TypeScript-side field naming.
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const result = await runner.run(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      runtimeUser,
      containerName,
      pythonBinary,
      "-c",
      SEED_PYTHON_SCRIPT,
    ],
    { stdin: payload },
  );
  assertSuccess(result, `seed Hermes session ${sessionId}`);
  return { sessionId };
}

/**
 * Generate a deterministic-per-run session id with the eval test in the
 * suffix so `hermes sessions list` inside a debugging shell makes it
 * obvious which row came from which eval.
 */
export function generateHermesEvalSessionId(
  testId: string,
  runId: string,
): string {
  // Use a stable prefix + the run-scoped pieces. Underscore separators
  // mirror upstream Hermes session-id conventions (telegram-<uid>-...).
  return `evals_${testId}_${runId}`;
}
