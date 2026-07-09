# SQLite insert-scaling benchmark — UUIDv7 vs UUIDv4

Measures how SQLite write performance depends on **where a new row lands in the
table's B-tree**, not on the total size of the database — comparing a
time-ordered UUIDv7 key against a random UUIDv4 key.

## What it does

1. Builds two `messages` tables and fills each to `TARGET_BYTES` (default
   **5 GiB**). Both have the **identical** schema —
   `id TEXT PRIMARY KEY, content TEXT NOT NULL` with `WITHOUT ROWID` so the UUID
   clusters the table — and both store `content` as JSON text in the same shape
   as the real `messages.content` column (a stringified array of content blocks
   `[{ "type": "text", "text": ... }]`, sized **5–50 KiB** per row). The only
   variable is how `id` is generated:

   | File         | id generator                               | Insert pattern |
   |--------------|--------------------------------------------|----------------|
   | `uuidv7.db`  | UUIDv7 (RFC 9562, time-ordered, monotonic) | The ms timestamp in the high bits keeps ids increasing, so new rows sort to the rightmost leaf — inserts **append** to one hot page. |
   | `uuidv4.db`  | UUIDv4 (fully random)                      | Ids sort to random positions — inserts **scatter** across the tree (page splits, cache misses). |

   (Bun has no native UUIDv7 generator, so the script includes a small
   spec-shaped monotonic v7 implementation; `crypto.randomUUID()` supplies v4.)

2. Reopens each DB with default cache size and realistic durability pragmas
   (`journal_mode=WAL`, `synchronous=NORMAL`), then times **`BATCH_COUNT` (10)**
   transactions of **`BATCH_ROWS` (50)** inserts against each and reports the
   average / median / min / max per-batch time and the ratio between them.

The fill phase uses fast, non-durable pragmas (`journal_mode=OFF`,
`synchronous=OFF`, large cache) because it is setup, not part of the
measurement.

## Run locally

```bash
# Full 5 GiB run (slow — the UUIDv4 fill is the expensive part)
bun run benchmarking/sqlite/bench-insert-scaling.ts

# Quick sanity run at 200 MiB
OUT_DIR=/tmp/sqlite-bench TARGET_BYTES=$((200*1024*1024)) \
  bun run benchmarking/sqlite/bench-insert-scaling.ts
```

## In CI

The benchmark runs via the `Benchmark - SQLite insert scaling` GitHub Actions
workflow on `workflow_dispatch` (run it from the Actions UI; all knobs are
exposed as inputs) and on PRs that touch these files. It uses the smallest
GitHub-hosted runner (`ubuntu-latest`); databases are written to whichever
scratch volume has the most free space (checked up front), and results are
posted to the job summary.

> **Activation step:** the workflow YAML is staged in this directory as
> `benchmark-sqlite-insert.yaml` because the automation that opened the PR
> lacks the GitHub `workflow` OAuth scope required to write under
> `.github/workflows/`. To enable it, move the file into place from a client
> that has workflow scope:
>
> ```bash
> git mv benchmarking/sqlite/benchmark-sqlite-insert.yaml \
>        .github/workflows/benchmark-sqlite-insert.yaml
> ```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OUT_DIR` | cwd | Directory for the `.db` files |
| `TARGET_BYTES` | `5368709120` (5 GiB) | Fill size per DB |
| `MIN_ROW_BYTES` | `5120` (5 KiB) | Smallest content payload |
| `MAX_ROW_BYTES` | `51200` (50 KiB) | Largest content payload |
| `BATCH_ROWS` | `50` | Rows per measured batch |
| `BATCH_COUNT` | `10` | Measured batches per DB |
| `FILL_TX_ROWS` | `500` | Rows per fill transaction |

## Interpreting results

Expect the random UUIDv4 key to be meaningfully slower than the time-ordered
UUIDv7 key. Two effects drive the gap:

- **Page splits / rebalancing** — random keys constantly insert into the middle
  of full leaf pages, forcing splits and interior-page rewrites. This shows up
  even when the whole DB fits in cache.
- **Cache misses** — once the working set exceeds RAM (SQLite's page cache and
  the OS page cache), random inserts must fetch cold pages from disk while
  the monotonic UUIDv7 keeps hitting the same hot rightmost page.

Caveat: on a large-RAM machine a 5 GiB file may largely fit in the OS page
cache, which compresses the second effect. The first effect is always present,
and raising `TARGET_BYTES` past available RAM makes the gap starker. The
real-world takeaway is unchanged: for high-write tables prefer time-ordered keys
(UUIDv7 or ULID) over random ones (UUIDv4) so inserts append instead of scatter
— or, for internal tables that are never exposed externally, a plain
`INTEGER PRIMARY KEY` rowid, which is smaller and faster still.
