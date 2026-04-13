# Backup — Troubleshooting

Operational procedures for diagnosing and recovering from snapshot issues.

## "snapshot in progress" errors that don't clear

### Symptom

Backup CLI commands (`vellum backup create`) and scheduled snapshot ticks repeatedly fail with one of:

- `snapshot in progress (locked by pid <N>)`
- `snapshot in progress (lock holder unidentified; possible partial write)`
- `snapshot in progress (lock contended)`

The errors persist across retries and do not resolve on their own.

### Cause

The snapshot system uses a cross-process lock file to prevent two processes from running the backup pipeline concurrently (which could corrupt backup bundles or race the retention pruner). The lock file is created atomically via `O_CREAT | O_EXCL` and contains the holder's PID.

In rare cases a writer can crash after creating the lock file but before writing its PID, leaving a zero-byte or malformed lock file with no live holder. The acquire loop cannot safely unlink such a file (it could belong to a live holder that has just won `O_EXCL` but not yet flushed its PID), so it surfaces contention indefinitely.

### Recovery

1. Confirm no backup is actually in progress — check the assistant log for recent `snapshot-worker` activity and look for a running process holding the lock.

2. Inspect the lock file:

   ```bash
   ls -l ~/.vellum/backups/.snapshot.lock
   cat ~/.vellum/backups/.snapshot.lock
   ```

   If the file is empty, zero-byte, or contains no parseable PID, it is stuck debris from a crashed writer.

   If it contains a PID, verify the process is gone:

   ```bash
   kill -0 <pid> 2>&1  # "No such process" means the holder is dead
   ```

3. Remove the lock file:

   ```bash
   rm ~/.vellum/backups/.snapshot.lock
   ```

4. Retry the backup operation. The next acquire attempt will succeed on the now-empty slot.

### Docker mode

In containerized deployments the backup root is controlled by `VELLUM_BACKUP_DIR` (default `/workspace/.backups/`). The lock file lives one level above the local backups directory — adjust the path in the commands above accordingly, e.g. `/workspace/.backups/.snapshot.lock`.
