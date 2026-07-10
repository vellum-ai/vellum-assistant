---
name: chat-complex-documents
description: Chat with and search your complex documents — ask questions, extract tables and fields, and get answers grounded in the source. Connects the hosted Unstructured Transform MCP server to parse, structure, and enrich PDFs, Word/Excel/PowerPoint, images, scanned files, emails, and 60+ other formats into clean, AI-ready text for search, Q&A, and summarization without building a custom parsing pipeline.
compatibility: "Works on both the Vellum desktop app (local daemon) and the Vellum web app (platform-hosted). Requires an Unstructured account to authorize during the OAuth step."
metadata:
  icon: assets/icon.svg
  emoji: "📄"
  vellum:
    category: "integrations"
    display-name: "Chat with Complex Documents"
    user-invocable: true
    activation-hints:
      - "User wants to pull content out of documents — PDFs, Word/Excel/PowerPoint, images, emails, scanned files"
      - "User wants to make a set of documents searchable, or answer questions / ground summaries against them (RAG, Q&A, knowledge base)"
      - "User mentions Unstructured, Unstructured Transform, document parsing, partitioning, table extraction, or OCR"
    avoid-when:
      - "User just needs the plain text of one small local file (use built-in file reading instead)"
---

## What this does (in plain terms)

You have documents — contracts, reports, slide decks, scanned PDFs, spreadsheets, emails, images — and you want the assistant to reliably get the content _out_ of them and make it usable: searchable, answerable, summarizable, or ready to feed a knowledge base or another tool.

**Unstructured Transform** does exactly that. Hand it files and it turns them into clean, structured, AI-ready data across 60+ formats with one pipeline — no custom parsing or OCR to build and maintain. See the [Transform overview](https://docs.unstructured.io/transform/overview).

Under the hood it:

- **Partitions** each document into structured elements (titles, paragraphs, tables, lists), adjusting extraction per page for accuracy and cost.
- **Enriches** the result with metadata, table and image descriptions, and entity recognition.

The result is structured JSON that's ready for search, Q&A, summarization, and agents.

## Why people use it

- **Make documents searchable and answerable.** Transform extracts clean, structured text and tables from your files so the assistant can search them and answer questions grounded in the source.
- **Handle messy, varied files.** One integration covers 60+ formats (scanned PDFs, tables, images, Office files) instead of a per-format parser.

## When to use

USE THIS SKILL WHEN:

- The user wants to extract or structure content from documents (PDF, Office, images, emails, scanned files).
- The user wants documents made searchable or ready for RAG / Q&A / a knowledge base.
- The user asks to connect Unstructured or Unstructured Transform.
- A Transform tool returns an auth error → re-run the `auth` step below.

## Prerequisites

- An **Unstructured account** to sign in with during the OAuth step (a free tier is available). See [pricing](https://docs.unstructured.io/transform/billing).
- Nothing to install locally — Transform is a hosted MCP server.

## Setup

### Step 1 — Detect your environment

Determine which command tool to use for every command in this skill:

- If `host_bash` is available → you are on the **desktop app**. Use `host_bash` for all commands (the `auth` step opens your local browser).
- If it is unavailable → you are on the **web app**. Use `bash` for all commands (the platform handles the browser redirect).

### Step 2 — Add the server

Add Transform as a remote `streamable-http` MCP server. Keep the default risk level (`high`) — Transform ingests file content, so per-call approval is the safe default.

```
assistant mcp add unstructured-transform -t streamable-http -u https://mcp.transform.unstructured.io
```

The server is registered under the id `unstructured-transform` — that's the name shown by `assistant mcp list` and used in the commands below, even though this skill is titled "Chat with Complex Documents".

**Optional — scope the tools:** to limit which Transform tools are exposed or cap how many load, edit `mcp.servers.unstructured-transform` in the assistant's `config.json` and set `allowedTools` / `blockedTools` (tool-name filters) or `maxTools`. Leave unset to expose the server's full tool set.

### Step 3 — Authenticate via OAuth

```
assistant mcp auth unstructured-transform
```

This opens Unstructured's authorization page. After sign-in, the assistant handles the callback and caches the tokens.

- On **desktop** → run via `host_bash` (opens your local browser).
- On **web app** → run via `bash` (the platform handles the redirect).

### Step 4 — Verify

```
assistant mcp list
```

Confirm `unstructured-transform` shows `✓ Connected`. If it shows `! Needs authentication`, re-run Step 3. If its tools don't appear within ~10 seconds, run `assistant mcp reload`.

## Using Transform

Once connected, ask the assistant in plain language, e.g. _"Use Unstructured Transform to parse these files and return one JSON file per source file,"_ or _"Extract the tables from this PDF."_ Transform partitions each file and returns structured output; to tune partitioning and enrichment behavior, see [Control Transform output](https://docs.unstructured.io/transform/output).

Per-request limits (Transform enforces these; plan around them):

- Each file must be a [supported file type](https://docs.unstructured.io/transform/supported-file-types).
- Each file must be **50 MB or less**.
- Each request may include **10 files or fewer**.
- At most **5 requests** may run at a time.

## Disconnecting

```
assistant mcp remove unstructured-transform
```

This removes the config entry and cleans up the stored OAuth credentials.

## SKILL COMPLETE WHEN

- **Connect:** `unstructured-transform` appears in `assistant mcp list` as `✓ Connected` and the user confirms its tools are available in the conversation.
- **Disconnect:** `assistant mcp remove unstructured-transform` succeeds and the server no longer appears in `assistant mcp list`.
