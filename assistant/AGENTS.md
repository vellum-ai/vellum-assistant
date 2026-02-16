# Assistant Agent Instructions

## Tooling Direction

Do not add new tool registrations using the `class ____Tool implements Tool {` pattern.

Prefer skills in `assistant/skills/vellum-skills/` that teach the model how to use CLI tools directly.

## Migration Guidance

When touching existing tool-based flows, migrate behavior toward skill-driven CLI usage instead of adding new registered tools.

Reasoning: every registered tool increases model context overhead, while the model can usually learn CLI usage from skills on demand and install missing CLI dependencies when needed.
