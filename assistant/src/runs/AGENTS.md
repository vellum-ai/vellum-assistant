# Runs

Async work that takes a while gets a **run**, not a notification.

A run is created when work starts and **updated in place** as it progresses, so
an hour of skill learning produces one row in the feed rather than a stream of
events. A one-shot notification is written once, after something finished, and
has no in-progress state at all; that is why subagents, skill learning, and
scheduled runs used to be invisible until they failed.

## Producing a run

Call `startRun()` from `run-store.ts` and drive the handle:

```ts
const run = startRun({ kind: "subagent", label: "Competitor research" });
run.progress("Reading the second source");
await run.succeed({ notable: true, summary: "Found three competitors." });
```

Most background work does not need to call this directly: `runBackgroundJob()`
opens a run for every job it wraps, which covers the heartbeat, filing, memory
consolidation, watchers, sequences, subagents, and scheduled executions.

## Rules

- **Runs enter the notification pipeline once, at most.** Start and progress
  skip it entirely: nothing is being decided and nothing is being pushed. Only
  `needs_input`, `failed`, and a success the producer marked `notable` become
  real notifications, and they go through `emitNotificationSignal` like every
  other producer so routing, dedupe, and copy rendering keep working.
- **`notable` defaults to false.** A default of "always" rebuilds the noise the
  revamp removed. Mark a success notable only when it produced something the
  user would go and look at.
- **`silent: true` for routine infrastructure.** A run whose failures the user
  cannot act on never notifies; its failures roll into a System health counter
  instead (`home/system-health.ts`).
- **Short work leaves no trace.** A run writes no row until it has been alive
  for `SURFACE_DELAY_MS`. Do not defeat this by writing a row yourself.
- **Never leave a run open.** Every path out of the work must reach a terminal
  transition. A producer that drops one has its run swept to `interrupted`,
  which is a worse row than the truth, and a crash must never be able to leave a
  spinner turning forever.
- **Runs are a Vellum-surface concept.** Telegram and Slack users do not get run
  chatter. Only the notifying transitions above fan out to channels.

## Persistence

A run's feed row **is** its persistence: `run:<runId>` in the home feed, which
gives it the writer's replace-in-place merge, the `home_feed_updated` broadcast,
and client read state with no parallel store to reconcile. Do not add one.

`run-sweeps.ts` runs two passes on a timer, plus one at startup: it folds
routine finished runs into a single digest row, and closes any non-terminal row
whose run is not live.
