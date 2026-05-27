# @vellumai/assistant-api

Public API surface for consumers of the assistant runtime — web client, gateway,
evals, future external clients. This directory is the **source of truth** for
the wire contracts the assistant exposes: schemas, types, and pure helpers.

Internal assistant code imports the files in this directory via relative paths
(e.g. `../../api/events/open-url.js`). External consumers import the
materialized npm-style package `@vellumai/assistant-api`, regenerated into
`apps/web/node_modules/` by `apps/web/scripts/postinstall.ts`.

## Architecture

A single discriminated-union schema, `AssistantEventSchema`, covers every event
type whose wire contract is canonical. The web parser (`event-parser.ts`) tries
this schema first; events not yet covered fall through to a hand-rolled legacy
switch. The migration goal is to drain the switch — each event moved here
shrinks the legacy surface and makes wire-shape drift a compile error.
