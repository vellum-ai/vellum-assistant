# postgres

Experimental plugin for backing the assistant with PostgreSQL instead of
SQLite.

This is an early scaffold. Today it contributes a single `init` hook that
verifies a PostgreSQL installation is reachable on `PATH` before the plugin
loads. If none of `pg_ctl`, `postgres`, or `psql` respond to `--version`, the
hook throws and the loader aborts bootstrap for this plugin so the missing
dependency surfaces loudly.

Future work (provisioning, schema, and the SQLite → PostgreSQL backend swap)
builds on top of this check.
