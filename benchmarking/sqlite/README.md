# SQLite insert-scaling benchmark

Measures how SQLite write performance depends on **where a new row lands in the
table's B-tree**, not on the total size of the database.

## What it does

1. Builds two `messages` tables and fills each to `TARGET_BYTES` (default
   **5 GiB**). Both store `content` as JSON text in the same shape as the real
   `messages.content` column — a stringified array of content blocks
   (`[{ "type": "text", "text": ... }]`), sized **5–50 KiB** per row. They
   differ only in the primary key:

   | File            | Schema                                                       | Insert pattern |
   |-----------------|--------------------------------------------------------------|----------------|
   | `sequential.db` | `id INTEGER PRIMARY KEY` (monotonic rowid)                   | New rows sort to the rightmost leaf — inserts **append** to one hot page. |
   | `random.db`     | `id TEXT PRIMARY KEY` (UUID), `WITHOUT ROWID`                | The UUID clusters the table, so new rows sort to random positions — inserts **scatter** across the tree (page splits, cache misses). Mirrors the real UUID-keyed `messages` table. |

2. Reopens each DB with default cache size and realistic durability pragmas
   (`journal_mode=WAL`, `synchronous=NORMAL`), then times **`BATCH_COUNT` (10)**
   transactions of **`BATCH_ROWS` (50)** inserts against each and reports the
   average / median / min / max per-batch time and the ratio between them.

The fill phase uses fast, non-durable pragmas (`journal_mode=OFF`,
`synchronous=OFF`, large cache) because it is setup, not part of the
measurement.

## Run locally

```bash
# Full 5 GiB run (slow — the random fill is the expensive part)
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

Expect random-key inserts to be meaningfully slower than sequential ones. Two
effects drive the gap:

- **Page splits / rebalancing** — random keys constantly insert into the middle
  of full leaf pages, forcing splits and interior-page rewrites. This shows up
  even when the whole DB fits in cache.
- **Cache misses** — once the working set exceeds RAM (SQLite's page cache and
  the OS page cache), random inserts must fetch cold pages from disk while
  sequential inserts keep hitting the same hot rightmost page.

Caveat: on a large-RAM runner a 5 GiB file may largely fit in the OS page
cache, which compresses the second effect. The first effect is always present,
and raising `TARGET_BYTES` past available RAM makes the gap starker. The
real-world takeaway is unchanged: for high-write tables prefer monotonic keys
(autoincrement integers, or time-sortable IDs like ULID / UUIDv7) over random
ones so inserts append instead of scatter.
