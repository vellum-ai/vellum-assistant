# work_result

structured receipt after completed work

```
{ eyebrow?, status?: "completed"|"partial"|"failed"|"in_progress", summary?, metrics?: [{ label, value, detail?, tone?: "neutral"|"positive"|"warning"|"negative" }], sections?: [{ id?, title, description?, type?: "items"|"timeline"|"diff"|"artifacts"|"warnings", items?: [{ id?, title, description?, status?, tone?, metadata?: [{ label, value }], href? }], diffs?: [{ label?, before?, after? }] }] }: structured receipt after real work; keep display-only unless follow-up buttons are needed. An item `href` makes the row a link: an in-app path (e.g. "/assistant/skills/<skillId>?tab=history") opens in place, an https URL opens externally; other schemes are ignored
```
