# Memory v1

The legacy (tier-v1) memory engine: PKB knowledge base, segment/summary embedding jobs, and PKB filing. Active only when `isMemoryV1Active()` (see `assistant/src/config/memory-v3-gate.ts`). The v1 graph read engine lives in `v1/graph/`; the all-tier graph store and dispatcher remain in `../graph/`. Do not add features here.
