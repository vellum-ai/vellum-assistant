<!-- PR title format: type(scope): description -->
<!-- Examples: feat(slack): add user token support, fix(cli): handle missing config, docs(architecture): update API table -->

<!-- Link Linear issues with a closing keyword anywhere in this body so they're -->
<!-- picked up by the Linear Release CLI when this ships. Closes / Fixes / -->
<!-- Resolves all work; bare `LUM-1234` mentions do not. -->
<!-- e.g. `Closes LUM-1234`, `Part of ATL-539`. -->

## Prompt / plan
<!-- What prompt or plan was used to generate this code? Link to a plan file, paste the prompt, or describe the approach. -->

## Test plan
<!-- How was this change verified? e.g. unit tests, manual testing, CI checks -->

## CLI verb checklist
<!-- For PRs that add a new IPC route under assistant/src/runtime/routes/: -->
<!-- - [ ] Does this route need an `assistant` CLI verb? If yes, add a thin -->
<!--       wrapper in assistant/src/cli/commands/ via registerCommand (same -->
<!--       PR or a follow-up). -->
<!-- - [ ] If no, leave a one-line note explaining why (e.g. internal-only, -->
<!--       composed by another command). -->
<!-- Delete this section if your PR does not add any new routes. -->
