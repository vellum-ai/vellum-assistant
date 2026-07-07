---
name: plugin-builder
description: "Use when the user wants to build, scaffold, ship, or edit a Vellum plugin that bundles hooks, tools, and skills into one installable package."
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧩"
  vellum:
    category: "development"
    display-name: "Plugin Builder"
    activation-hints:
      - "User wants to build, scaffold, or author a Vellum plugin"
      - "User wants to edit, update, or push changes to an existing plugin's GitHub repo"
      - "User wants to package skills, hooks, or tools into an installable plugin"
      - "User wants to extend their assistant with a new capability shipped as a plugin"
      - "User wants to publish a plugin to the Vellum marketplace catalog"
      - "User asks how to ship or distribute extensions for Vellum"
    avoid-when:
      - "User only wants to install or upgrade an existing plugin (use the `assistant plugins` CLI directly)"
      - "User only wants to author a single SKILL.md (use the skill-management skill)"
      - "User wants to add a one-off user_route or webhook (use the `assistant routes` skill)"
---

# Plugin Builder

Build on top of Vellum with plugins. A plugin bundles hooks, tools, and skills into a single installable package that extends what an assistant can do.

Plugins are in beta. The peer-dep range you declare is what gets you load. Treat everything you write as something that can break between Vellum releases until 1.0 ships, and pin a real range.

## What is a plugin?

A plugin is a directory in the assistant's workspace (`<workspaceDir>/plugins/<name>/`) that groups different surfaces into one cohesive capability. The assistant can build plugins directly in this folder or install one from the community via the CLI:

```
assistant plugins install <name>
```

Plugins can also be discovered and managed from the Plugins tab in the app, or searched from the CLI with `assistant plugins search`. The catalog is a curated allowlist that the Vellum team approves and curates.

## The surfaces a plugin can bundle

A single plugin can contribute several different kinds of behavior. Each surface is discovered by convention from a named subdirectory. Missing directories are simply skipped, so a plugin contributes only what it ships.

| Surface                                    | Lives in          | What it does                                                                                                                     |
| ------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Lifecycle hooks](references/hooks.md)     | `hooks/<name>.ts` | Run code at fixed points in the Assistant's lifecycle to read or transform what flows through, and broadcast progress to the UI. |
| [Skills](references/skills.md)             | `skills/<name>/`  | Directories of instructions and associated assets, scripts, and resources that the Assistant loads dynamically when relevant.    |
| [Model-visible tools](references/tools.md) | `tools/<name>.ts` | Add new tools the model can call. Plugin tools land in the same catalog as built-in tools.                                       |

The two extensibility patterns serve different goals. **Plugins are for distribution**: you intend to share the capability, publish to the marketplace, or install it across multiple assistants. The plugin manifest (`package.json`), the `@vellumai/plugin-api` peer dependency, and the install flow exist to make a capability portable, versioned, and discoverable by others.

**Direct workspace contributions are for personal extension**: you simply want to extend your assistant and have no intention of distributing the work. Skip the plugin packaging entirely. Drop the file directly into the matching top-level workspace directory (`/workspace/tools/<name>/` for a tool, `/workspace/skills/<name>/` for a skill, etc.) and the assistant picks it up automatically. No manifest, no install step, no peer dependency. Lifecycle hooks are the one exception: they can only be contributed through a plugin, since there is no direct `/workspace/hooks/` path.

Several surfaces that plugins contribute run in the same process as the main Assistant process. They can import all internal methods from the Assistant from the single public package, [`@vellumai/plugin-api`](https://github.com/vellum-ai/vellum-assistant/tree/main/assistant/src/plugin-api), which is the only supported contract. Anything not exported from there is internal and can change without notice. See `references/plugins.md` for the full export surface.

## Coming from another harness?

Vellum's plugin model was designed to line up with the agent harnesses you may already use. The shared vocabulary is deliberate to be as portable as possible with the other entrants in the industry.

## Before you write a single file

Ask before building. Five questions, in this order. Stop if the user is unclear on any of them.

1. **What job does the plugin do?** One sentence, plain language. If you cannot write this, the plugin should not be built yet.
2. **Which surfaces does it ship?** Tools (model calls), hooks (lifecycle transforms), and skills (on-demand instructions) are the three. Most plugins ship one or two, not all three. See `references/plugins.md` for the directory layout and manifest, and the surface-specific references for each surface's contract.
3. **Does it need credentials?** An API key, OAuth token, or webhook secret is not a value that belongs in a `.ts` file. For LLM inference credentials, use `getConfiguredProvider()` from `@vellumai/plugin-api` to route through the workspace's stored credentials without handling plaintext. For other credential types (OAuth tokens, webhook secrets), store them via the credential vault and resolve at runtime through the assistant's credential system.
4. **Where will the source live?** A GitHub repo, ideally under the user's own namespace. The marketplace entry pins to a full commit SHA.
5. **Is the user writing TypeScript or compiling ahead?** In-repo Bun/Node compile on assistant start is the default. If they want a different build, ask now.

You have an alignment problem if the user cannot answer questions 1 and 2. Push back and clarify before scaffolding. The most expensive waste of plugin-authoring time is building a plugin whose job is fuzzy.

## Scaffold the directory

Choose a kebab-case directory name. It becomes the install name. `@scope/<name>` is allowed; the loader strips the scope for the runtime plugin name. Duplicate names fail registration. See `references/plugins.md` for the full directory layout, manifest fields, and loader rules.

To exercise the plugin locally before pushing to the catalog, you have two options:

**Option A: direct copy.** Copy the directory into the workspace's `plugins/` folder:

```
cp -R my-plugin $VELLUM_WORKSPACE_DIR/plugins/my-plugin
```

**Option B: install from a GitHub URL (untrusted).** If the plugin is already pushed to a public GitHub repo, install it directly without waiting for marketplace review:

```
assistant plugins install https://github.com/owner/my-plugin
assistant plugins install https://github.com/owner/repo/tree/my-branch/packages/my-plugin
assistant plugins install owner/repo --name my-plugin
```

A URL install bypasses the marketplace entirely: the tree is cloned verbatim (no adapter stub is overlaid) and the source is **untrusted**. The CLI prints a yellow warning naming the source. See `references/distribution.md` for the full details.

## Write the README

The README is the storefront. Every marketplace plugin should have the same visual header at the top so users can scan and compare. The header is a centered card with four elements: icon, title, tagline, and badges.

```markdown
<div align="center">

<img src="hero.png" width="200" alt="My Plugin">

# my-plugin

**one-line tagline that says what it does**

![version](https://img.shields.io/badge/version-0.1.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![made for](https://img.shields.io/badge/made%20for-Vellum-8A2BE2)

[What You Get](#what-you-get) • [Requirements](#requirements) • [Install](#install) • [Usage](#usage)

</div>

---
```

The four required elements:

1. **Icon.** A hero image or logo, centered, 200px wide. This is the visual identity of the plugin. If you do not have one, skip the image tag but keep the centered title block.
2. **Title.** The plugin name as a top-level heading.
3. **Short description.** One line in bold, directly under the title. What the plugin does in plain language. No marketing fluff.
4. **Badges.** Version, license, and a "made for Vellum" badge. Use [shields.io](https://shields.io) static badges.

Section navigation links below the badges are optional but recommended so users can jump to what matters.

Below the header, write whatever sections make sense for your plugin. The header is the standard part.

### Example

See the [travel-planner README](https://github.com/AnitaKirkovska/travel-planner#readme) for a reference implementation.

## Verify before shipping## Verify before shipping

1. Plugin directory copied into `plugins/<name>/`, `assistant plugins list` shows status `ok` (not `error`, not `skipped`).
2. `assistant plugins inspect <name>` reports `up-to-date` and `drift: none`.
3. Each surface exercised on a real code path: a tool called by the model, a hook fires on the right event, a skill loads when hints match.
4. Compiled files win: if you ship both `.js` and `.ts` for the same basename, the `.js` is loaded.

If a surface fails to load or fire, see `references/plugins.md` for loader rules and `references/distribution.md` for the CLI diagnostic commands.

## Shipping to the catalog

See `references/distribution.md` for the full publishing walkthrough (push to GitHub, add a `marketplace.json` entry with a copy-pasteable template, and what the review checks), plus the manifest schema, CLI commands, and commit-pinning rules.

Once merged, users install by name: `assistant plugins install my-plugin`. The new plugin is picked up automatically.

## SKILL COMPLETE WHEN

- Job and surfaces locked in the alignment pass (questions 1 and 2 answered).
- Directory matches the loader convention (`hooks/`, `tools/`, `skills/`, optional `src/`).
- `package.json` declares `name`, `version`, and a real `peerDependencies["@vellumai/plugin-api"]` range.
- Each surface has been exercised locally with a working example.
- A `README.md` has the standard visual header (icon, title, short description, badges).
- A `marketplace.json` entry exists with a full SHA in `source.ref`, and the Vellum team's review is in flight.

## Reference files

- `references/plugins.md`: Directory layout, manifest fields, and the full `@vellumai/plugin-api` export surface.
- `references/hooks.md`: Every lifecycle hook with its context fields, the agent loop diagram, resolution order, and a hook anatomy example.
- `references/tools.md`: Tool definition fields, the execute context, result shape, resolution order, and a tool anatomy example.
- `references/skills.md`: Frontmatter reference, resolution order, and a skill anatomy example.
- `references/distribution.md`: Marketplace catalog, CLI commands, drift and upgrades, the manifest schema, commit pinning, and adapters.
