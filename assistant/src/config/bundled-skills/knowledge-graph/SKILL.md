---
name: knowledge-graph
description: Query the entity knowledge graph to explore relationships between people, projects, tools, and other entities tracked in memory
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🕸️","vellum":{"display-name":"Knowledge Graph"}}
---

# Knowledge Graph

Query the entity knowledge graph to explore relationships between people, projects, tools, and other entities tracked in memory.

## When to use

- When the user asks about relationships between entities ("what tools does project X use?", "who works on project Y?")
- When the user wants to explore connected entities across the knowledge graph
- When automatic memory recall doesn't surface the right relationship-based information

## Capabilities

- **Neighbors**: Find entities directly connected to seed entities (optionally filtered by relation and entity type)
- **Typed traversal**: Multi-step traversal with type constraints at each step (e.g., "me -> works_on -> projects -> uses -> tools")
- **Intersection**: Find entities reachable from ALL given seeds (e.g., "projects both Alice and Bob work on")
