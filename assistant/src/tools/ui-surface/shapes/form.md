# form

input form, single or multi-page

```
{ description?, fields: [{ id, type: "text"|"textarea"|"select"|"toggle"|"number"|"password", label, placeholder?, required?, defaultValue?, options?: [{ label, value }] }], submitLabel? }. Multi-page: { pages: [{ id, title, description?, fields }], pageLabels?: { next?, back?, submit? }, submitLabel? }
```
