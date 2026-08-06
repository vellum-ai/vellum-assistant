// ---------------------------------------------------------------------------
// Compile-time cross-check helpers for provider webhook schemas.
//
// Provider normalizers validate untrusted payloads at runtime with tolerant
// Zod schemas, which stay the sole runtime validators. These type-only helpers
// layer a compile-time check over such a schema against the provider's official
// published types (e.g. `@grammyjs/types`, `@slack/types`) so a drift from the
// real API shape fails `tsc` instead of silently mis-parsing a live event. The
// official-types import at each call site is `import type` only and is erased
// from the build.
//
// The check is one-directional on purpose: our schemas are intentionally a
// *narrower and looser* view (only the fields the normalizer reads, each
// optional and `.catch()`-guarded), so we do NOT require our type to satisfy
// the official one — only that we never contradict it.
//
// Usage — collect the assertions in a throwaway tuple type so `tsc` evaluates
// them; a violated assertion resolves to `false` and fails `Expect`:
//
//   type _Checks = [
//     Expect<ModeledKeysAreOfficial<z.infer<typeof mySchema>, OfficialEvent>>,
//     Expect<OfficialValueSatisfiesOurs<z.infer<typeof mySchema>, OfficialEvent>>,
//   ];

/** Asserts its argument type is exactly `true`; a `false` fails the build. */
export type Expect<T extends true> = T;

/**
 * Every key we model is a real key on the official type — a typo like
 * `messsage_thread_id`, which would otherwise always parse to `undefined`,
 * fails the build.
 */
export type ModeledKeysAreOfficial<Ours, Official> =
  keyof Ours extends keyof Official ? true : false;

/**
 * A real official value is accepted by our tolerant schema — modeling a field
 * with the wrong primitive (e.g. an id as a string) fails the build.
 */
export type OfficialValueSatisfiesOurs<Ours, Official> = Official extends Ours
  ? true
  : false;
