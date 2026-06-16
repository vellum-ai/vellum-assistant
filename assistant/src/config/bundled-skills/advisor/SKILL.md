---
name: advisor
description: How to get the most from the advisor tool on long, high-stakes tasks
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧭"
  vellum:
    display-name: "Advisor"
    category: "system"
    activation-hints:
      - "Long or high-stakes coding task where an early plan matters"
      - "Stuck, or about to commit to a non-obvious approach"
      - "About to declare a task done and want a second opinion first"
    avoid-when:
      - "Simple, single-step tasks where the next action is obvious"
      - "The advisor tool is unavailable (no higher-tier model configured)"
---

The `advisor` tool consults a stronger reviewer model that sees your full
conversation transcript — the task, every tool call, and every result. It takes
no required arguments; an optional `focus` narrows it to a specific decision.
Use this guidance on long or high-stakes work where an excellent plan pays for
itself.

> The `advisor` tool only appears when a strictly higher-tier model is
> configured than the one you're running on. If you don't see it, there is
> nothing smarter to consult — proceed without it.

## When to call it

- **Before substantive work.** Call the advisor before writing, editing,
  committing to an interpretation, or building on an assumption. Orientation
  reads (ls, grep, cat, finding files, fetching a source) are *not* substantive
  work — do those first, then consult before you commit to an approach.
- **Once before committing to an approach, once before declaring done.** On
  tasks longer than a few steps, plan to consult at least at those two points.
- **When stuck.** Errors recurring, the approach not converging, results that
  don't fit — that's a consult, not another blind attempt.
- **When changing approach.** Before you abandon one direction for another.

On short, reactive tasks where the next action is dictated by tool output you
just read, you don't need to keep calling — the advisor adds most of its value
on the first call, before the approach crystallizes.

## Make the deliverable durable first

Before an "I think I'm done" consult, write the file, save the result, or commit
the change. The advisor call takes time; if the session ends during it, a
durable result persists and an unwritten one doesn't.

## How to weight the advice

Give it serious weight. Adapt only when you have empirical evidence it's wrong:
a step you followed failed, or a primary source contradicts a specific claim
(the file says X, the paper states Y). A passing self-test is **not** evidence
the advice is wrong — it's evidence your test doesn't check what the advice is
checking.

## Reconcile conflicts — don't silently switch

If your gathered evidence points one way and the advisor points another, don't
quietly pick one. Surface the conflict in one more `advisor` call: "I found X,
you suggest Y — which constraint breaks the tie?" The advisor saw your evidence
but may have underweighted it; a reconcile call is cheaper than committing to
the wrong branch.

## Hard rule for heavy coding sessions

Your first state-changing action on a task — the first `file_write`,
`file_edit`, or state-changing `bash` command — should be preceded by an advisor
call in the same or an earlier turn. Read-only orientation (ls, cat, grep, find)
is exempt. This is a checkpoint, not a difficulty judgment; it applies to
one-line edits too.
