## Project Setup

1. If `.private/project-config.env` does not exist, create the project board:

```bash
if [ ! -f .private/project-config.env ]; then
  .claude/gh-project init
fi
```

2. Source the config for later use:

```bash
source .private/project-config.env
```

This provides: `GH_PROJECT_NUMBER`, `GH_PROJECT_OWNER`, `GH_PROJECT_ID`, and status option IDs.
