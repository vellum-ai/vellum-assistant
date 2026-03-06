# Bundled Skill CLI Retrieval Pattern

Use this pattern for setup/status reads in bundled skills:

1. Run Vellum CLI reads through `bash` (not `host_bash`).
2. Use domain commands (for example `assistant integrations twilio config`) instead of direct gateway `curl`.
3. Let the CLI handle gateway auth internally; do not instruct manual bearer headers for read paths.

When a skill needs outbound API calls with a stored credential (outside of Vellum CLI reads), use proxied bash:

```yaml
bash:
  network_mode: proxied
  credential_ids:
    - "<credential-id>"
  command: |
    curl -s https://api.example.com/resource
```

