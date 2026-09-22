# Pending platform feature flags

Registry keys that still need a Terraform entry in
`vellum-assistant-platform`. One line per flag. Delete the row when the
key exists in `terraform/gcp/env/prod/vellum-assistant/main.tf`.

| Flag | Note |
| ---- | ---- |
| `experiment-activation-checklist-2026-09-10` | not opened; default off (control) |
| `assistant-inbox` | not opened; default off; scope client |
| `assistant-reply-push` | not opened; default on |
| `channel-trust-floors` | not opened; default on |
| `figma-oauth` | not opened; default off |
| `inline-assistant-intermediates` | deferred; local opt-out only |
| `interrupt-on-send` | vellum-assistant-platform #10474; default off; scope both |
| `local-notification-avatar` | [vellum-assistant-platform #10502](https://github.com/vellum-ai/vellum-assistant-platform/pull/10502); default off; scope client |
| `mcp-add-server` | not opened; default off |
| `paired-devices-ui` | not opened; default off |
| `quickbooks-oauth` | not opened (Terraform entry drafted alongside the platform change); default off |
| `schedule-result-notify` | not opened; default on |
| `session-groups` | [vellum-assistant-platform #10577](https://github.com/vellum-ai/vellum-assistant-platform/pull/10577); default off; scope both |
| `shopify-oauth` | not opened; default off |
| `sidebar-done` | not opened; default off; scope both |
| `send-user-message` | vellum-assistant-platform #10475; default off; scope both |
| `web-presence-suppression` | not opened; default on |
