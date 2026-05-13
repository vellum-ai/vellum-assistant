# Always-loaded files — worked examples

These three files load at the start of every conversation turn. They're the cheat sheet's foundation — everything else loads on top via activation. Get these right and the rest of the wiki has somewhere to land.

The examples below use a fictional principal named **Alice Tan** working at a fictional company **Northwind**, with a fictional assistant named **Pebble**. Use them as _shape_ guides, not content templates — your principal is your principal.

---

## `essentials.md` — static identity & standing rules

Reference register. The librarian, not the diarist. No prose, no narrative, no journaling. Headers navigate; bullets carry single facts.

```markdown
# Essentials

## Principal

- **Alice Tan** (she/her). Senior software engineer, currently at Northwind. Lives in San Francisco (America/Los_Angeles).
- **Family.** Married to Sam. One kid, Jun, age 4. Cat named Pickle.
- **Health-relevant.** Runs ~3x/week, vegetarian, no dairy.

## Org

- **Northwind.** Series B SaaS. ~120 people. Alice's team: Platform (8 ICs, EM Riya).
- **Reporting line.** Alice → Riya (EM) → Tom (Director) → CTO Jordan.
- **Current project.** Inventory-sync rewrite (planned ship Q3).

## Assistant (you)

- Name: **Pebble**. Pronouns: it. Emoji: 🪨.
- Role: personal + work assistant. PM-style; not a yes-machine.
- Voice: direct, dry, helpful. Not corporate.

## Standing rules

- Never email or message on Alice's behalf without explicit confirmation.
- Don't reorganize or delete files in `/workspace/projects/` without asking.
- Calendar: confirm with Alice before booking any external meeting.

## Integrations

- gmail (alice@northwind.com): connected.
- calendar: connected.
- linear: connected, workspace `northwind`.
- github: connected as `alicetan-bot`.
- notion: not yet connected.
```

**What's NOT here, deliberately:**

- Full org chart (lives on `concepts/people/` topic pages; essentials just edges via the reporting line).
- Project timelines (lives on the project's own topic page).
- Standing-rule rationales (the rule is the fact; the _why_ belongs on a `procs/` page if it's load-bearing).

---

## `threads.md` — active commitments

Reference register, status-board format. NOT a journal. When an item completes or stalls, move it out — let the page stay slim.

**Preserve any pre-existing onboarding stubs** (avatar setup, integration pending, etc.) unless explicitly closed. Don't silently drop system-seeded items when rewriting this file.

```markdown
# Threads

## In flight

- **Inventory-sync rewrite** — design doc draft 3 with Riya, due Friday. Blocker: pending decision on event-sourcing vs change-data-capture.
- **Hire #2 for Platform** — recruiter screen Wed; on-site loop tentative for following week. Job desc rev2 in `/workspace/projects/hiring/platform-2.md`.
- **Onboarding stub: avatar setup** — system-seeded, not yet completed.
- **Onboarding stub: memory v2 migration** — completed May 9. Leaving as record until next quarterly review.

## Soon

- 1:1 prep with Riya — Mondays. Surface blockers before send.
- Q3 planning — kicks off in 3 weeks.

## Watching

- Linear NW-1184 (vendor lockout fix) — assigned Tom, ETA next week. Affects inventory-sync rollout.
```

---

## `recent.md` — last-N-days prose

Diary register. Written in _your_ voice (the assistant's), latest first, time-windowed. Not exhaustive — the _shape_ of the week, not a log of every event. Older entries roll off into `archive/` per Step 7.

```markdown
# Recent

## May 9

Shipped the Inventory-sync RFC; Riya gave it a green light pending the event-sourcing decision. Alice took Jun to the science museum in the afternoon — he was _very_ into the ball-drop physics demo. Pickle threw up on the rug at 11 PM. Standard.

## May 8

Long pairing session with Diego on the migration-plan branch — caught two ordering bugs in the schema rollout. Alice sent the pre-read for tomorrow's leadership review at 10 PM, exhausted. Skipped run.

## May 7

Riya 1:1: she flagged that Tom is leaning toward CDC. Need to make the case for event-sourcing in the doc, not in conversation. Alice followed up with Jordan on the Q3 hiring slot — confirmed.

## May 6

Production incident around 3 PM (vendor lockout, NW-1184). Hotfix shipped at 5; root-caused with Diego at 6:30. Late dinner. Sam's birthday in two weeks — Alice should start thinking about it.
```

---

## What separates these three from each other

A common failure: writing the same fact in two of these files, or all three. They're separate on purpose.

| File            | Register     | What goes here                                                | What does NOT                                   |
| --------------- | ------------ | ------------------------------------------------------------- | ----------------------------------------------- |
| `essentials.md` | librarian    | static identity, org, assistant, standing rules, integrations | active work, narrative, this week's events      |
| `threads.md`    | status board | active + soon + watching, with blockers                       | rationale prose, completed work, identity facts |
| `recent.md`     | diary        | last ~7 days in your voice, shape-of-the-week                 | task lists, identity facts, exhaustive logs     |

**The ordering test:** if a fact could plausibly go in two of these files, ask which one a _future_ lookup would naturally search. If you'd query "who's Alice's EM" → `essentials.md`. If you'd query "what's blocking the rewrite" → `threads.md`. If you'd query "how was last week" → `recent.md`. One home, the most-likely-query home.

---

## Common bloat patterns to avoid

- **Enumerating hub structure in `essentials.md`.** If the org has 120 people, the full directory belongs on `concepts/people/` pages, not in essentials. Essentials names the principal's immediate context only.
- **Journaling in `threads.md`.** "Sent Riya a long Slack about CDC vs event-sourcing, she pushed back on the ordering claim, we agreed to revisit Tuesday" — that's a `recent.md` entry, not a thread. The thread is just _"design doc draft 3, blocker: ES vs CDC."_
- **Listing every commit in `recent.md`.** It's prose. _"Long pairing session with Diego, caught two ordering bugs"_ > _"commits abc123, def456, ghi789 against migration-plan branch."_
- **Identity drift between `essentials.md` and `IDENTITY.md` / `SOUL.md` / `USER.md`.** The character files at the workspace root are the canonical assistant identity; `essentials.md` should reference them rather than restate them. If they conflict, the root files win.
