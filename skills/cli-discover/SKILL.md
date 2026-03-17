---
name: cli-discover
description: Discover which CLI tools are installed, their versions, and authentication status
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔍"
  vellum:
    display-name: "CLI Discovery"
---

# CLI Discovery

When you need to discover what CLI tools are available on the system, use `host_bash` to check directly. Do not use sandboxed `bash` for discovery - it may not see host-installed CLIs or auth state, leading to false negatives.

## Checking if a CLI exists

```bash
which <name>        # returns path if found, exits non-zero if missing
command -v <name>   # alternative, works in all POSIX shells
```

## Getting version info

```bash
<name> --version    # most CLIs support this flag
```

Use a 5-second timeout to avoid hanging on unresponsive CLIs.

## Auth-check commands

For CLIs that support authentication, check whether the user is logged in:

| CLI | Auth check command |
|-----|-------------------|
| `gh` | `gh auth status` |
| `aws` | `aws sts get-caller-identity` |
| `gcloud` | `gcloud auth list --filter=status:ACTIVE --format=value(account)` |
| `az` | `az account show` |
| `vercel` | `vercel whoami` |
| `netlify` | `netlify status` |
| `fly` | `fly auth whoami` |
| `heroku` | `heroku auth:whoami` |
| `railway` | `railway whoami` |

## Common CLIs worth checking

When doing a broad discovery, check these categories:

- **Version control & code hosting:** `gh`, `git`, `gitlab`
- **Project management:** `linear`, `jira`
- **Communication:** `slack`
- **Cloud providers:** `aws`, `gcloud`, `az`
- **Containers & infra:** `docker`, `kubectl`, `terraform`
- **Runtimes & package managers:** `node`, `bun`, `deno`, `python3`, `pip3`
- **HTTP clients:** `curl`, `httpie`
- **Hosting & deploy:** `vercel`, `netlify`, `fly`, `heroku`, `railway`

## Output format

Report findings in markdown:

```markdown
## Available CLIs

- **git** (/usr/bin/git) - git version 2.x.x
- **gh** (/usr/bin/gh) - gh version 2.x.x [authenticated: user@example.com]
- **bun** (~/.bun/bin/bun) - 1.x.x

## Not found: jira, linear, slack
```
