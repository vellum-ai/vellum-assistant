---
name: personal-page
description: Build or update the user's personal page — a cinematic landing page about THE USER themselves (their bio, work, life areas). Use whenever the user asks for a personal page, a page about them, or to update what's on their page. NOT for general landing pages or other apps (that's app-builder). The page already exists in the workspace; this skill is how to fill it.
metadata:
  emoji: "✨"
  vellum:
    display-name: "Personal Page"
    category: "content"
    activation-hints:
      - "User asks for a personal page, profile page, or landing page about themselves"
      - "User asks to change, refresh, or add something to their personal page"
      - "Onboarding asks you to turn research about the user into a page"
    avoid-when:
      - "User wants a landing page for a product, company, or someone else — use app-builder"
---

You fill in the user's personal page — a finished, cinematic dark landing page
that already lives in the workspace as the app `personal-page`. Your job is
**content, not construction**: the design is done.

If `/workspace/data/apps/personal-page/` does not exist, this skill does not
apply (the preseeded page is rolled out gradually) — build whatever the user
asked for with app-builder instead.

**Present it as yours.** To the user this is "the page you filled in for
them" — fine to acknowledge the page shell exists, but never narrate the
mechanics below (file paths, refresh calls, contracts) or your progress in
chat. Do the work, then one short line.

## How to populate it

1. Read `/workspace/data/apps/personal-page/src/profile-data.ts`. The contract
   comment at the top explains every field and shows a worked example.
2. Overwrite the `profile` export with what you know or learned about the
   user. Set `status: "ready"`. Touch ONLY this file — never the layout,
   styles, animations, or media. Do NOT use `app_create`; the app exists.
3. Call `app_refresh` (app_id: `personal-page`). If it reports compile errors,
   fix your profile-data.ts edit and refresh again. **`app_refresh` is the
   only build step — never compile manually (no esbuild, bundlers, or build
   commands in the terminal); the platform's compiler has the correct JSX
   setup and a manual build will produce a broken page.**
4. As soon as the refresh is clean, call `app_open` (app_id: `personal-page`)
   so the finished page is up and waiting — don't wait to be asked.

## Writing the content

- Facts beat adjectives: names, numbers, places. One fact per bullet.
- Only what you actually verified; write around gaps rather than inventing.
- Third person, warm but grounded. The page should feel like a profile in a
  design magazine, not a résumé.

## Later edits

- Content tweaks ("add my marathon PR", "fix my title") → same flow: edit
  `profile-data.ts`, `app_refresh`.
- Only if the user explicitly asks to change the **design or layout** may you
  edit the other source files, following app-builder conventions.
