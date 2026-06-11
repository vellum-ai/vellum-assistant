---
name: skill-management
description: Create, edit, and delete custom managed skills in the user's workspace. Use whenever the user wants to author a new skill from a description, scaffold a SKILL.md, or remove a skill they no longer need.
metadata:
  emoji: "\U0001F9E9"
  vellum:
    display-name: "Skill Management"
    category: "system"
    activation-hints:
      - "User wants to scaffold a new managed skill in their workspace from a description"
      - "User wants to delete or list the custom skills they have defined"
      - "User wants to author or edit a SKILL.md and have it become invocable as a skill"
    avoid-when:
      - "User just wants to use an existing skill — that is normal skill activation, not management"
---

Manage the lifecycle of custom managed skills in `{workspaceDir}/skills`.

## When to Use

USE THIS SKILL WHEN:
- The user says "build me a skill" or "create a skill for X"
- The user wants to scaffold, edit, or delete a SKILL.md in their workspace
- The user wants a repeatable workflow captured as an invocable skill

Do NOT use this skill when the user just wants to run an existing skill. That is normal activation, not management.

## Capabilities

- **Scaffold** a new managed skill with YAML frontmatter and markdown body
- **Edit** an existing skill by scaffolding over it (rewrites the SKILL.md in place)
- **Delete** an existing managed skill directory

Skills created via `scaffold_managed_skill` become available for `skill_load` when a valid top-level `SKILL.md` is written under the skill directory.

## Step 1 - Align with the user before building

Ask before doing anything. Do not scaffold a skill until you have confirmed with the user:

- What the skill should do
- When it should activate (the trigger phrases, in their words)
- The major steps it performs
- Any destructive steps and the done condition

> ✓ Checkpoint: Have you confirmed scope with the user? If you are guessing at any of the four points above, ask first. Do not scaffold on assumption.

## Step 2 - Write a description AND activation-hints, always both

The description is what makes the skill discoverable. It must cover both what the skill does and when to reach for it, phrased the way the user would say it.

```yaml
description: Build anything visual — apps, landing pages, dashboards, trackers,
  calculators, games, tools, slide decks, or data visualizations. Use whenever
  the user wants something built that they can see and interact with.
```

**Every skill must also ship `activation-hints` in its frontmatter. This is not optional.** Keep `activation-hints` separate from the description: the description sells the skill, the hints list the concrete trigger phrases the user confirmed in Step 1.

```yaml
metadata:
  vellum:
    activation-hints:
      - "build me an app"
      - "make a dashboard"
      - "create a landing page"
```

> ✓ Checkpoint: Does the frontmatter have both a description and an `activation-hints` list? If hints are missing, go back and add them before writing the body.

## Step 3 - Structure the body so it survives weak models

Strong models tolerate loose structure. Weaker models drift. Build every body with these patterns.

**Open with a `## When to Use` block.** User language, not jargon. This is what makes the model recognize when the skill applies.

**Put critical warnings at the point of action.** A warning at the top of a file is forgotten by the time the model is 200 lines deep. Do not trust the top-of-file warning. Repeat the danger where the dangerous action happens.

```markdown
## Step 5 - Apply the JSON blob

⚠️ CRITICAL: Use the complete blob below. Setting even one key
wipes the entire block. Copy the whole thing or fail.
```

**Add explicit checkpoints between major steps, sparingly.** Long executions blur together. The model finishes step 3 and slides into step 4 without re-anchoring. A checkpoint forces a re-read. Use them between major sections, not on every step.

**Make branching explicit with `If / →`, and always name the default.** Prose hides decisions. The model reads linearly and walks past a branch without registering it. Every `If` must cover the default case. Implicit fall-through ("otherwise figure it out") creates drift.

```markdown
If the user already has a draft → restructure it into the template.
If not → build the steps from their description (default).
```

## Step 4 - Define done by binding tool calls to artifacts

Without an explicit done condition, the model invents one. It stops too early ("the file was created, done") or overshoots ("let me add one more feature"). Both are drift.

Each completion criterion must bind a **tool call** to the **user-visible artifact** it produces. Do not write criteria the model can satisfy by narration alone.

```markdown
## SKILL COMPLETE WHEN

- [ ] `scaffold_managed_skill` wrote the SKILL.md and returned its path
- [ ] User confirmed the skill loads via `skill_load`
- [ ] User saw the trigger phrases that will activate it
```

> ✓ Checkpoint: Before scaffolding, confirm the body has a `## When to Use` block, point-of-action warnings on any dangerous step, explicit `If / →` branches with named defaults, and artifact-bound completion criteria.

## Step 5 - Keep SKILL.md under 500 lines

Past 500 lines the model loses things in the middle. Warnings get buried, branching loses visibility, and the file fights the task for the same context budget. If a skill is growing past 500 lines, split reference material into separate files the skill points to.

## Step 6 - Test the skill before calling it done

After scaffolding, load the skill and confirm it activates on the intended trigger and follows its own steps. If it does not activate or drifts, fix the body and test again.

How you exercise it depends on what the skill does:

- **If the skill performs side effects** (sends messages, deletes data, makes purchases, mutates external state) → do not trigger a live run during creation. Confirm it loads and activates on the intended trigger (static check), then ask the user before exercising it for real.
- **Otherwise** (read-only or local-only skills) → run it against a realistic prompt directly. This is the default.

> ⚠️ CRITICAL: Do not tell the user a skill is ready until you have confirmed it loads and activates on the intended trigger. A skill that was never loaded is a skill that was never tested. Never perform user-visible side effects just to test a skill without the user's consent.
