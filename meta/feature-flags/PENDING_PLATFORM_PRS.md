# Pending platform feature flags

Registry keys that still need a Terraform entry in
`vellum-assistant-platform`. One line per flag. Delete the row when the
key exists in `terraform/gcp/env/prod/vellum-assistant/main.tf`.

| Flag | Note |
| ---- | ---- |
| `assistant-reply-push` | not opened; default on |
| `channel-trust-floors` | not opened; default on |
| `figma-oauth` | not opened; default off |
| `inline-assistant-intermediates` | deferred; local opt-out only |
| `interrupt-on-send` | vellum-assistant-platform #10474; default off; scope both |
| `mcp-add-server` | not opened; default off |
| `paired-devices-ui` | not opened; default off |
| `schedule-result-notify` | not opened; default on |
| `send-user-message` | vellum-assistant-platform #10475; default off; scope both |
| `web-presence-suppression` | not opened; default on |
