# Memory v1

The legacy (tier-v1) memory engine: PKB knowledge base, segment/summary embedding jobs, and PKB filing. Active only when `isMemoryV1Active()` (see `assistant/src/config/memory-v3-gate.ts`). The v1 graph read engine lives in `v1/graph/`; the all-tier graph store and dispatcher remain in `../graph/`. Do not add features here.

Slated for deletion — see the runbook in `../AGENTS.md` ("Deletion runbook: v1") for the blocking prerequisites, the external consumers to repoint or retire, and the ordered steps. In particular `migrateToolCreatedItems` in `v1/graph/bootstrap.ts` must be MOVED, not deleted: it is a registered, append-only migration step.
