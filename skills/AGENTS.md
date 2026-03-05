# Skills Contribution Guide

- **Skills must be self-contained and portable**
  - Use `scripts/` for supporting logic with inline dependencies
  - Do not install CLIs into Vellum or the host system; provide instructions for users to install external packages if needed
  - Do not create new assistant tools and reference them from SKILL.md — this couples skills to Vellum internals and breaks compatibility with other agent systems

- **API interactions should use Vellum's proxy**
  - Update proxy settings so the bash tool can inject correct auth headers
  - Applies to curl, fetch(), CLI commands — the proxy intercepts network traffic for approved domains
  - Avoid instructions that tell the assistant to find and use secrets directly

- **Write portable instructions**
  - Avoid referring to tools by specific names (prefer "Take a browser screenshot" over "Use browser_screen_grab")
  - Use standard frontmatter according to the [Agent Skills specification](https://agentskills.io/home) — linters validate this

- **Vellum-specific extensions**
  - If you must do something Vellum-system specific, use the `metadata` field to connect the skill in a structured way
