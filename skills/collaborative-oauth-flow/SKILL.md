---
name: collaborative-oauth-flow
description: Reusable pattern for walking users through OAuth app setup via AppleScript browser navigation
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔑"
  vellum:
    display-name: "Collaborative OAuth Flow"
---

This skill provides the **Collaborative Guided Flow** pattern for OAuth app setup. It is not invoked directly - it is included by service-specific OAuth skills (e.g., `google-oauth-applescript`).

See `references/collaborative-guided-flow.md` for the full pattern: navigation helper, step rhythm, rules, credential collection, error handling, tone, and guardrails.

Service-specific skills should define only their provider-specific steps (URLs, APIs, scopes, consent screen flows) and rely on this pattern for everything else.
