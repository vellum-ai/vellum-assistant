# Guardian forms

A guardian form is how a CLI command asks a human to confirm something before
it happens. The command parks, a form appears in the guardian's app, and the
write happens only if somebody answers it.

The property that makes this worth having: **the daemon does not write.** With
nobody at a form, nothing is written and the command times out. That is
enforced by where the code lives, not by a policy check.

## The rail

```
CLI            daemon                guardian's app          gateway
 |  command      |                        |                     |
 |------------->|  openGuardianForm       |                     |
 |  (parks)     |----- form event ------->|                     |
 |              |                         |  guardian answers   |
 |              |                         |--- POST ----------->| submitGuardianForm
 |              |                         |                     |   claim
 |              |                         |                     |   write
 |              |<---- resolve callback --------------------- |
 |<-- result ---|                         |                     |
```

Two files own everything that is the same for every form:

- `assistant/src/runtime/guardian-form-registry.ts` holds the open forms, the
  deadlines, the claim, and the settle window.
- `gateway/src/http/routes/guardian-form-submit.ts` takes the claim, runs the
  write, and reports the outcome back to the parked call.

`assistant/src/runtime/routes/contact-prompt-routes.ts` and
`gateway/src/http/routes/contact-prompt.ts` are the worked example.

## Adding a form

**1. Park the command.** In a daemon route, call `openGuardianForm` with a kind,
how to broadcast the form, and how to take it down:

```ts
return openGuardianForm<MyResult>({
  kind: "my-feature.thing",
  timeoutMs,
  logContext: { operation },
  broadcast: {
    open: (requestId) => broadcastMessage({ type: "my_form_request", requestId, ... }),
    closed: (requestId, reason) =>
      broadcastMessage({ type: "my_form_closed", requestId, reason }),
  },
});
```

The returned promise settles on an answer, a dismissal, or the deadline, and
never rejects. Whatever the writer reports comes back to the caller verbatim.

**2. Write on submit.** In a gateway route, hand the write to
`submitGuardianForm`:

```ts
if (body.cancelled === true) {
  return submitGuardianForm({ requestId, cancelled: true, logContext });
}

return submitGuardianForm({
  requestId,
  logContext,
  write: async () => {
    try {
      const row = await doTheWrite(...);
      return { resolution: { id: row.id } };
    } catch (err) {
      return { failure: { error: "...", status: 422 } };
    }
  },
});
```

A dismissal and a write are separate calls: the options type takes one or the
other, so a caller cannot accidentally report "cancelled" over a form the
guardian answered. Classify expected failures into `failure` rather than
throwing; a throw is caught as a backstop and reported as a 500, which loses
the status you meant.

Whatever you put in `resolution` reaches the parked caller untouched, via the
form-agnostic `resolve_guardian_form` callback, except `requestId` and
`error`: those are the rail's, one addressing the callback and the other
marking the outcome a failure. Contacts pin the older
`resolve_contact_prompt` name, so pass `resolveOperation` only if you have the
same reason.

Fields sent beside an `error` reach the parked caller too, so a failure can say
what kind it was. A dismissal uses that: it reports `cancelled: true` alongside
its error string, which lets a command tell "the guardian closed the form" from
"the write failed" without matching on the message. The rail's own `ok` and
`error` still win over anything the writer sends under those names.

**3. Render the card.** Add the form event to the web client's pending
interaction pipeline and give it a card. This is still per-form wiring; see
`clients/web/src/domains/chat/components/contact-record-card.tsx`.

## Things that are easy to get wrong

- **The claim is what makes concurrency safe.** The form goes to every
  connected client, so more than one can answer it. The first claim wins, and
  the claim is also what stops the answer deadline: an answer landing near the
  deadline must not race the write it started. Do not write before claiming,
  and do not reimplement the claim.
- **A dismissal takes the same claim as a write.** Otherwise one client
  dismissing while another is mid-submit tells the caller nothing happened
  while the other answer is still on its way to the database.
- **A claimed form owes a report.** Once claimed, the caller is waiting on you.
  A failure has to be reported too, or the command sits until its settle timer
  while the client's retry comes back as a duplicate.
- **Only the gateway can offer the "daemon never writes" guarantee today.** The
  rail's safety comes from the write living in a different process that the
  client reaches directly. A form over something the daemon itself owns would
  need its own enforcement story; do not assume this one carries over.
- **State a form's target in the parked `meta`, not only in the broadcast.** A
  client that does not know the field echoes nothing back, and a writer reading
  only the submission would then write somewhere else without saying so. The
  address form parks its `contactId` and the gateway reads it back over
  `contact_prompt_flags` before binding. A readable parked form is the only word
  on the target: an echoed value is honored only when that form cannot be read,
  and a form that cannot be read at all is refused rather than guessed at.
- **`hasUnclaimedGuardianForm` takes the kinds to check.** Pass only the kinds
  whose cards actually collide. Sweeping the whole registry would let any
  pending form block every other one.
