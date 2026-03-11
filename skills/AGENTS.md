# Skills Contribution Guide

- **Skills must be self-contained and portable**
  - Use `scripts/` for supporting logic with inline dependencies
  - When including code assets, utilities, or tools, load the [scripts best practices specification](https://agentskills.io/skill-creation/using-scripts.md) first
  - **External dependencies in Bun/TypeScript scripts**: pin versions directly in the import path (e.g., `import { Command } from "commander@13.1.0"`). Bun auto-installs missing packages at runtime when no `node_modules` directory is found. Do NOT add a `package.json` or `bun.lock` to skill directories — this disables Bun's auto-install behavior and breaks portability.
  - Do not install CLIs into Vellum or the host system; provide instructions for users to install external packages if needed
  - Do not create new assistant tools and reference them from SKILL.md — this couples skills to Vellum internals and breaks compatibility with other agent systems
  - Do not include a TOOLS.json file in skill directories — skills should rely on CLI tools in `scripts/`, not custom tool definitions

- **Follow the [Agent Skills specification](https://agentskills.io/specification)**
  - All skills must conform to the spec's SKILL.md format: required YAML frontmatter (`name`, `description`), optional fields (`license`, `compatibility`, `metadata`, `allowed-tools`), and Markdown body
  - The `name` field must match the parent directory name, use only lowercase alphanumeric characters and hyphens (1-64 chars), and must not start/end with a hyphen or contain consecutive hyphens
  - Use the spec's directory structure: `SKILL.md` at root, `scripts/` for executable code, `references/` for supplementary docs, `assets/` for static resources
  - Follow progressive disclosure: keep `description` keyword-rich for discovery (~100 tokens), keep `SKILL.md` body under 500 lines (< 5000 tokens recommended), and move detailed reference material to `references/`

- **API interactions use Vellum's outbound proxy**
  - Outbound network traffic from the bash tool is automatically intercepted by an outbound proxy in a manner that's transparent to the assistant
  - Update proxy settings so the bash tool can inject correct auth headers for approved domains
  - Avoid instructions that tell the assistant to find and use secrets directly

- **Write portable instructions**
  - Avoid referring to tools by specific names (prefer "Take a browser screenshot" over "Use browser_screen_grab")
  - It is fine to refer to tools/utils/etc. directly by name if it is bundled with the skill (likely in `scripts/`)
  - Use standard frontmatter according to the [Agent Skills specification](https://agentskills.io/specification) — linters validate this

- **Vellum-specific extensions**
  - If you must do something Vellum-system specific, use the `metadata` field to connect the skill in a structured way
