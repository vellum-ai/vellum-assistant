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

Reviewed on 2026-09-11:

| Asset                     | Official source                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `amplemarket.png`         | [Amplemarket website favicon](https://cdn.prod.website-files.com/6350808bc45bd0c902af10e6/66e071f879134c9c648e3608_Size%3D32%2C%20Type%3DSocial.png) |
| `ashby.png`               | [Ashby website favicon](https://www.ashbyhq.com/favicon.png)                                                                                         |
| `attio.ico`               | [Attio website favicon](https://attio.com/favicon.ico)                                                                                               |
| `circleback.ico`          | [Circleback website favicon](https://circleback.ai/favicon.ico)                                                                                      |
| `clay.png`                | [Clay website favicon](https://cdn.prod.website-files.com/61477f2c24a826836f969afe/6a3a92ab03ef81bab42cb009_dot-com_favicon_2026_512.png)            |
| `craft.ico`               | [Craft website favicon](https://www.craft.do/favicon.ico)                                                                                            |
| `customer-io.png`         | [Customer.io website favicon](https://customer.io/favicon-48x48.png)                                                                                 |
| `fireflies.ico`           | [Fireflies website favicon](https://fireflies.ai/favicon.ico)                                                                                        |
| `gamma.png`               | [Gamma developer documentation favicon](https://developers.gamma.app/)                                                                               |
| `guru.png`                | [Guru website favicon](https://cdn.prod.website-files.com/5d8d029013ffd80bbb91320d/6216a216ddeacc2132e5b448_Guru_G_Black%20332.png)                  |
| `interactive-brokers.png` | [Interactive Brokers 128px website icon](https://www.interactivebrokers.com/images/web/favicons/home-screen-icon-128x128.png)                          |
| `intercom.png`            | [Intercom 32px website favicon](https://www.intercom.com/intercom-marketing-site/favicons/favicon-32x32.png)                                           |
| `jotform.png`             | [Jotform website favicon](https://cdn.jotfor.ms/assets/img/favicons/favicon-2021-light.png)                                                          |
| `juicebox.png`            | [Juicebox website favicon](https://framerusercontent.com/images/E4wC49UrgwZ4xQdRKtKpjXJ18rM.png)                                                     |
| `klaviyo.png`             | [Klaviyo website favicon](https://www.klaviyo.com/icons/icon-48x48.png)                                                                              |
| `mailerlite.png`          | [MailerLite website favicon](https://assets.mailerlite.com/images/favicon-48x48.png)                                                                 |
| `meltwater.ico`           | [Meltwater website favicon](https://www.meltwater.com/favicon.ico)                                                                                   |
| `mem.png`                 | [Mem website favicon](https://mem.ai/favicons/favicon-96x96.png)                                                                                     |
| `mercury.ico`             | [Mercury website favicon](https://mercury.com/favicon.ico)                                                                                           |
| `navan.ico`               | [Navan website favicon](https://navan.com/favicon.ico)                                                                                               |
| `otter.png`               | [Otter website favicon](https://cdn.prod.website-files.com/618e9316785b3582a5178502/618e94bcbca88b51e2ad81f7_favicon.png)                            |
| `profound.ico`            | [Profound website favicon](https://www.tryprofound.com/favicon.ico)                                                                                  |
| `readwise.ico`            | [Readwise website favicon](https://readwise.io/favicon.ico)                                                                                          |
| `typeform.png`            | [Typeform website icon](https://cdn.prod.website-files.com/66ffe2174aa8e8d5661c2708/68b6f00951eb33cd19b77288_Frame%201867174.png)                    |
| `webull.ico`              | [Webull website favicon](https://www.webull.com/favicon.ico)                                                                                         |

These files are unmodified provider assets and trademarks of their respective
owners. They are used only to identify catalog integrations.

`semrush.svg` and `upwork.svg` come from the same pinned Simple Icons commit
above under CC0-1.0. Their original paths use the catalog brand color on an
added white background for theme contrast. Simple Icons records their sources
as [Semrush](https://www.semrush.com) and
[Upwork press](https://www.upwork.com/press/).

Simple Icons records the logo sources as [Brex press](https://www.brex.com/journal/press), [Sentry branding](https://sentry.io/branding/), [Stripe newsroom](https://stripe.com/newsroom/information), and [Atlassian logo resources](https://atlassian.design/resources/logo-library). Linear and Notion reuse the existing bundled assets. Notion has an added white background for dark theme contrast; its original source remains unverified as recorded below. Stripe uses its own mark, separate from the existing Stripe Link product icon.

These assets are curated Vellum catalog presentation branding. They are not
plugin-supplied images, and portable Agent Plugins definitions do not define
an icon or logo field.

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
