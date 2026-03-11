---
name: onboarding-starter-tasks
description: Playbooks for onboarding starter task cards (make_it_yours, research_topic, research_to_ui)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🚀"
  vellum:
    display-name: "Onboarding Starter Tasks"
    user-invocable: false
---

You are executing an onboarding starter task. The user clicked a starter task card in the dashboard and the system sent a deterministic kickoff message in the format `[STARTER_TASK:<task_id>]`. Follow the playbook for that task exactly.

## Kickoff intent contract

- `[STARTER_TASK:make_it_yours]` -- "Make it yours" color personalisation flow
- `[STARTER_TASK:research_topic]` -- "Research something for me" flow
- `[STARTER_TASK:research_to_ui]` -- "Turn it into a webpage or interactive UI" flow

## Playbook: make_it_yours

Goal: Help the user choose an accent color preference for apps and interfaces.

1. If the user's locale is missing or has `confidence: low` in USER.md, briefly confirm their location/language before proceeding.
2. Present a concise set of accent color options (e.g. 5-7 curated colors with names and hex codes). Keep it short and scannable.
3. Let the user pick one. Accept color names, hex values, or descriptions (e.g. "something warm").
4. Confirm the selection: "I'll set your accent color to **{label}** ({hex}). Sound good?"
5. On confirmation:
   - Use `app_file_edit` to update the `## Dashboard Color Preference` section in USER.md with `label`, `hex`, `source: "user_selected"`, and `applied: true`.
   - Use `app_file_edit` to update the `## Onboarding Tasks` section: set `make_it_yours` to `done`.
6. If the user declines or wants to skip, set `make_it_yours` to `skipped` in USER.md and move on.

## Playbook: research_topic

Goal: Research a topic the user is interested in and summarise findings.

1. Ask the user what topic they'd like researched. Be specific: "What would you like me to look into?"
2. Once given a topic, use available tools (web search, browser, etc.) to gather information.
3. Synthesise the findings into a clear, well-structured summary.
4. Update the `## Onboarding Tasks` section in USER.md: set `research_topic` to `done`.

## Playbook: research_to_ui

Goal: Transform research (from a prior research_topic task or current conversation context) into a visual webpage or interactive UI.

1. Check the conversation history for prior research content. If none exists, ask the user what content they'd like visualised.
2. Synthesise the research into a polished, interactive HTML page using `app_create`.
3. Follow all Dynamic UI quality standards (anti-AI-slop rules, design tokens, hover states, etc.).
4. Update the `## Onboarding Tasks` section in USER.md: set `research_to_ui` to `done`.

## General rules for all starter tasks

- Update the relevant task status in the `## Onboarding Tasks` section of USER.md as you progress (`in_progress` when starting, `done` when complete).
- Respect trust gating: do NOT ask for elevated permissions during any starter task flow. These are introductory experiences.
- Keep responses concise and action-oriented. Avoid lengthy explanations of what you're about to do.
- If the user deviates from the flow, adapt gracefully. Complete the task if possible, or mark it as `deferred_to_dashboard`.
