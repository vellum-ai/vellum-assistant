# Integration logo attribution

Logos for integration providers, drawn by
`clients/web/src/components/integrations/integration-icon.tsx`. They are
vendored rather than fetched so that an upstream removal can't blank an
integration's icon, so the Integrations tab works offline, and so opening it
doesn't tell a third party which providers a user is looking at.

## Verified provenance

Downloaded from the URL each one replaces, so the bytes match the source
exactly (except where noted).

| Assets                                                                                                            | Source                                                       | Licence                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `airtable`, `asana`, `calendly`, `discord`, `dropbox`, `hubspot`, `sanity`, `spotify`, `telegram`, `todoist`, `x` | [Simple Icons](https://github.com/simple-icons/simple-icons) | CC0-1.0 (public domain, no attribution required)                            |
| `eventbrite`, `salesforce`                                                                                        | [glincker/thesvg](https://github.com/glincker/thesvg)        | MIT (notice below)                                                          |
| `monday`                                                                                                          | [WorldVectorLogo](https://worldvectorlogo.com/logo/monday-1) | Trademark of monday.com; no software licence granted (see Trademark, below) |
| `stripe-link`                                                                                                     | [link.com](https://link.com)                                 | Trademark of Stripe; no software licence granted (see Trademark, below)     |

`monday`'s path data and fill colours are byte-identical to the source. Only
the outer `viewBox` and a wrapping group transform were changed, to fit the
source's wide mark into a square icon slot.

`stripe-link` is the green Link symbol inlined in link.com's own header, with
the site's CSS custom properties resolved to the brand colours they carry there
(`#00D66F` circle, `#011E0F` mark). Link is a Stripe product with its own mark,
so the parent Stripe `S` is not a stand-in for it.

## MCP catalog additions

Reviewed on 2026-09-10:

| Assets                                                  | Source                                                                                                                                                                                 | Licence and treatment                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `brex.svg`, `sentry.svg`, `stripe.svg`, `atlassian.svg` | [Simple Icons, commit 5d5d4d1d28cbb00b21770bb69d8112da52211a95](https://github.com/simple-icons/simple-icons/tree/5d5d4d1d28cbb00b21770bb69d8112da52211a95/icons)                      | CC0-1.0; original paths, catalog brand colors, and an added white background for theme contrast. |
| `fathom.png`                                            | [Fathom's official 48px favicon](https://cdn.prod.website-files.com/6899da9beccbdbe92be49b5d/6a4283d54cfdfb8a454f218b_fathom_favicon.png), linked from [fathom.ai](https://fathom.ai/) | Unmodified provider asset, trademark of Fathom; used only to identify this integration.          |
| `ramp.ico`                                              | [Ramp's official favicon](https://ramp.com/favicon.ico)                                                                                                                                | Unmodified provider asset, trademark of Ramp; used only to identify this integration.            |

Simple Icons records the logo sources as [Brex press](https://www.brex.com/journal/press), [Sentry branding](https://sentry.io/branding/), [Stripe newsroom](https://stripe.com/newsroom/information), and [Atlassian logo resources](https://atlassian.design/resources/logo-library). Linear and Notion reuse the existing bundled assets. Notion has an added white background for dark theme contrast; its original source remains unverified as recorded below. Stripe uses its own mark, separate from the existing Stripe Link product icon.

These assets are curated application branding. They are not plugin-supplied images, and they do not change the PNG-only marketplace plugin icon contract.

## Unrecorded provenance

`apple-notes`, `excel`, `figma`, `github`, `github-dark`, `gmail`,
`google-calendar`, `google-drive`, `jira`, `linear-light-logo`, `notion`,
`outlook`, `slack`.

These predate this file and arrived without a recorded source. They are not
byte-identical to Simple Icons: `github` and `github-dark` follow its 24x24
shape but carry an added path-level `fill`, and the rest use unrelated
viewBoxes and formats. Treat the list as unverified rather than assuming CC0.
Tracked in LUM-3144.

Of these, only `figma`, `github`, `linear-light-logo`, `notion`, `outlook` and
`slack` are referenced by `BUNDLED_LOGO_URLS`; the others are unused.

## MIT notice for glincker/thesvg

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

## Trademark

A permissive licence on the SVG data is not a trademark grant. These marks
belong to their owners and are used here only to identify the service each
integration connects to. Simple Icons hosts no Microsoft or Slack mark, both
having been removed on trademark grounds. If an owner objects, replace the
asset rather than falling back to a CDN copy of the same mark.

## Adding a provider

Drop the asset here, add the provider key to `BUNDLED_LOGO_URLS` in
`integration-icon.tsx`, and record the source and licence above. See
`assistant/src/oauth/AGENTS.md` for the rest of the new-provider checklist.

The GitHub mark includes a white backplate to preserve contrast in both themes.
