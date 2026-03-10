# CLI Package — Contributing Guidelines

## Module Boundaries

- **Commands must not import from other commands.** Shared logic belongs in `src/lib/`. If two commands need the same function, extract it into an appropriate lib module rather than importing across `src/commands/` files.
