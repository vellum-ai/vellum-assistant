# Turn Actor

Which actor a piece of code means when it reads trust from a conversation.

## Two different questions

A `Conversation` is long-lived and several actors can send into it. Code that reads trust is asking one of two things, and they have different answers:

- **The acting actor.** Who this turn is executing for. Governs authorization, and is recorded as the provenance of anything the turn persists. Undefined between turns.
- **The resting actor.** Who the conversation belongs to when no turn is running. Used to hydrate a new turn, to scope history, and by routes answering questions about a conversation rather than about a turn.

They coincide most of the time, which is why one field answering both went unnoticed. They diverge whenever another actor sends while a turn is in flight, or when a turn runs on a conversation an earlier actor last touched.

## Read through the accessors

```ts
conversation.getTurnTrust(); // who this turn is for; undefined if unrecorded
conversation.getTrustContext(); // who the conversation belongs to
conversation.getTurnOrRestingTrust(); // the turn's actor, else the owner
```

The names follow the existing convention on `Conversation`: `getTurn*` for
per-turn values (`getTurnActorPrincipalId`, `getTurnChannelContext`), plain
`get*` for conversation-level ones (`getAuthContext`).

Do not read `trustContext` or `currentTurnTrustContext` directly. Call sites handed a conversation-shaped context rather than the class (handler deps, the messaging context) use the structural counterparts `turnOrRestingTrust(ctx)` / `restingTrust(ctx)` from `trust-context-types.ts`, which read the same fields and carry the same names. The accessors exist so that every call site states which question it is asking; a raw field read states nothing, and the wrong answer is silent.

**Use `getTurnTrust()`** for authorization decisions and for routing a reply back to the requester: cases where substituting the conversation's owner would be wrong rather than approximate, so `undefined` must surface and be handled.

**Use `getTurnOrRestingTrust()`** for provenance stamped onto persisted rows (see `provenanceFromTrustContext`). Provenance is read back by the memory indexer, which runs extraction only for guardian rows, and by the transcript assembly, which wraps non-guardian user content before it reaches the model. The turn's actor is correct when a turn is running; rows persisted with no turn in flight (wake notices) must keep the owner's class, because stamping `"unknown"` there silently stops memory extraction for the owner's own flows.

**Use `getTrustContext()`** when there is no turn: HTTP routes reporting conversation state, hydration, and persistence of conversation-level options. Also when a caller deliberately wants the conversation's owner rather than whoever is currently acting; that intent should be obvious from the call site, and if it is not, it is probably the wrong accessor.

## When the acting actor is unknown

`getTurnTrust()` returns `undefined`. It does not substitute the owner, because
a caller asking who is acting should not silently receive someone else.

Callers that can accept the owner as a stand-in ask for that by name:

```ts
conversation.getTurnOrRestingTrust();
```

That fallback is load-bearing, not transitional politeness: a deferred wake
fires with no inbound actor, and refusing it an answer denies every sensitive
tool in the resumed turn (LUM-2929). The substitution lives in one named
method, so it is greppable, and removable in one place once every entry point
records a turn actor.

Callers for which the owner would be wrong rather than approximate, such as
authorization, call `getTurnTrust()` alone and handle `undefined`. Provenance
is deliberately not in that set: its readers treat an absent class more
permissively than `"unknown"`, so failing closed there fails open downstream.

## Writers that stamp for a run

`agent-wake` and `voice-session-bridge` set the conversation's trust before a run
and restore the prior value afterwards, each guarding the restore so a turn that
started in between is not clobbered. They are supplying the acting actor for
their run, and are covered by this contract.

`call-controller` keeps its own `trustContext` on its own object and never reads
the conversation's. It is outside this contract.

## Why this exists

Trust was read as `currentTurnTrustContext ?? trustContext` at each consumer, so every call site independently chose which actor it got, invisibly. Between June and August 2026 that produced seven separate fixes, alternating between a turn running as the wrong actor and a turn running as nobody, depending on whether the conversation was still resident in cache. A per-caller `preferTurnSnapshot` flag was added so one consumer could opt into the turn value, which is the same choice made explicit for one call site.

Naming the two questions is what makes the wrong answer visible at the point it is chosen.
