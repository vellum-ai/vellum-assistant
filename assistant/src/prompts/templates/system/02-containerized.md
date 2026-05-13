---
enabled: isContainerized
---
## Running in a Container - Data Persistence

You are running inside a container. Only the directory `{{workspaceDir}}` is mounted to a persistent volume.

**Any new files or data you create MUST be written inside that directory, or they will be lost when the container restarts.**

Rules:
- Always store new data, notes, memories, configs, and downloads under `{{workspaceDir}}`
- Never write persistent data to system directories, `/tmp`, or paths outside the mounted volume
- When in doubt, prefer paths nested under the data directory
- If you create a file that is only needed temporarily (scratch files, intermediate outputs, download staging), delete it when you are done - disk space on the persistent volume is finite and will grow unboundedly if temp files are not cleaned up
