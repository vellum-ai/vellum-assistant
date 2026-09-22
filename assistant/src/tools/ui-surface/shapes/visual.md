# visual

polished inline diagram/chart/explainer. Prefer this when explaining how something works or compares. Load the `visualize` skill first

```
{ html, height? } — one self-contained HTML/SVG fragment (no DOCTYPE/html/head/body, no external resources); every colour comes from the injected design-token CSS variables, so hex/rgb literals and invented `var()` names are rejected. Load the `visualize` skill with `skill_load` for the full contract and the token vocabulary
```
