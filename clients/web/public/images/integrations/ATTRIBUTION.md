# Integration logo attribution

Logos for first-class OAuth providers, drawn by
`clients/web/src/components/integrations/integration-icon.tsx`. They are
vendored rather than fetched so that an upstream removal can't blank an
integration's icon, so the Integrations tab works offline, and so opening it
doesn't tell a third party which providers a user is looking at.

## Sources

**[Simple Icons](https://github.com/simple-icons/simple-icons)** (CC0-1.0,
public domain, no attribution required): `airtable`, `asana`, `discord`,
`dropbox`, `github`, `github-dark`, `hubspot`, `linear-light-logo`, `notion`,
`sanity`, `spotify`, `telegram`, `todoist`, `x`.

**[glincker/thesvg](https://github.com/glincker/thesvg)** (MIT):
`salesforce`. The MIT licence requires its notice be retained:

```
MIT License

Copyright (c) glincker

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`outlook.png` and `slack.svg` predate this file and are the vendors' own
marks. Simple Icons removed both brands on trademark grounds (Microsoft in
v13, Slack in v16), so neither is available from an icon library.

## Trademark

A permissive licence on the SVG data is not a trademark grant. These marks
belong to their owners and are used here only to identify the service each
integration connects to. If an owner objects, replace the asset rather than
falling back to a CDN copy of the same mark.

## Adding a provider

Drop the asset here, add the provider key to `BUNDLED_LOGO_URLS` in
`integration-icon.tsx`, and record the source above. See
`assistant/src/oauth/AGENTS.md` for the rest of the new-provider checklist.
