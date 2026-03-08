# Bundled Skill CLI Retrieval Pattern

When running the `assistant` CLI, run it using the `bash` (not `host_bash`) tool.

# Outbound Network Requests

When a skill needs outbound API calls with a stored credential (outside of `assistant` CLI reads), use proxied `bash`:

```yaml
bash:
  network_mode: proxied
  credential_ids:
    - "<credential-id>"
  command: |
    curl -s https://api.example.com/resource
```
