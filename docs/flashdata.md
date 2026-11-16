# FlashData web research and YouTube tasks

FlashData provides structured Google and YouTube data using your own [API key](https://flashdata.dev/app/api-keys). Queries consume your [FlashData Credits](https://flashdata.dev/pricing); installing the integration does not make API calls free. Vellum/model and storage charges are separate.

## Web Search provider

In Settings, under Models & Services, select FlashData for Web Search and enter your own key in the secure API-key field. The key must permit `google_search`. The provider uses the existing `web_search` tool, returns organic titles, links and snippets, and supports the result count and day/week/month/year freshness options. Offset pagination is not supported by this adapter.

The provider sends one POST to `https://data.flashdata.dev/v1/queries/realtime` with `source: "google_search"` and `X-API-Key` authentication. Requests that lose their response are not replayed because the original may already have consumed Credits. Check Jobs in the FlashData console before submitting again. Snippets are not full-page extraction.

Use a daemon release containing the FlashData provider with this settings entry. The key is provisioned to the daemon credential store, without a browser localStorage copy. Like the other keyed search providers, a configured FlashData key can also be selected by the existing fallback order when the preferred provider has no usable key; those queries consume your FlashData Credits too.

## Task skills

Each directory below is a self-contained skill for the skill catalog. Install the skills needed for your task. They use Vellum's existing credential proxy and secure credential input UI; follow the setup in the selected skill. The native provider's Settings key and a skill's credential-proxy entry are separate setup paths; never copy a secret through chat.

| Task | Skill | Output and boundary |
| --- | --- | --- |
| Google Search | [google-search-flashdata](../skills/google-search-flashdata/SKILL.md) | Ranked pages, links and snippets |
| Google News | [google-news-flashdata](../skills/google-news-flashdata/SKILL.md) | Article links, publishers and date labels; no guaranteed full text |
| Google Images | [google-images-flashdata](../skills/google-images-flashdata/SKILL.md) | Image URLs, dimensions and source pages; no download |
| Google Shopping | [google-shopping-flashdata](../skills/google-shopping-flashdata/SKILL.md) | Merchant/product/price snapshots; no stock or checkout guarantee |
| Google Videos | [google-video-search-flashdata](../skills/google-video-search-flashdata/SKILL.md) | Video results across websites |
| Google Places | [google-places-flashdata](../skills/google-places-flashdata/SKILL.md) | Places and available contact/rating fields |
| YouTube Search | [youtube-search-flashdata](../skills/youtube-search-flashdata/SKILL.md) | Up to 20 requested videos; actual count can be lower |
| YouTube Extended Search | [youtube-extended-search-flashdata](../skills/youtube-extended-search-flashdata/SKILL.md) | Up to 700 requested videos at a different rate |
| YouTube Metadata | [youtube-metadata-flashdata](../skills/youtube-metadata-flashdata/SKILL.md) | Descriptions, statistics and available chapters/formats |
| YouTube Transcript | [youtube-transcript-flashdata](../skills/youtube-transcript-flashdata/SKILL.md) | Existing timed automatic captions by default; no ASR/translation |
| YouTube Captions | [youtube-captions-flashdata](../skills/youtube-captions-flashdata/SKILL.md) | Existing uploader captions by default; no track fallback |
| YouTube License Metadata | [youtube-trainability-flashdata](../skills/youtube-trainability-flashdata/SKILL.md) | License/CC label; not training permission |
| YouTube Channel | [youtube-channel-flashdata](../skills/youtube-channel-flashdata/SKILL.md) | Channel profile and bounded recent uploads |
| YouTube Suggestions | [youtube-autocomplete-flashdata](../skills/youtube-autocomplete-flashdata/SKILL.md) | Actual suggestion phrases; not search volume |
| YouTube Download | [youtube-cloud-storage-flashdata](../skills/youtube-cloud-storage-flashdata/SKILL.md) | Non-secret planning and existing-job inspection; submission requires the user's protected environment |

The first 14 skills can submit queries using header-injected credentials. Download submission additionally needs storage secrets inside the request body, which this integration does not expose to the assistant. Its skill guides the user through protected submission and reads the resulting job. This is not full automatic download support. Managed assistants without local-static credential support need a supported platform connection.

## Validation and discovery

The adapter has mocked tests for successful results, empty results, access errors, rate limits, malformed responses and uncertain outcomes. No model/API calls or storage writes are needed for those tests. The skill specification and generated catalog can be checked offline. A successful price read after user setup verifies connectivity only, not paid retrieval or delivery.

The web provider and 15 skill definitions are distinct catalog surfaces. A source contribution or a locally generated catalog does not prove they are available in a released client or that demand queries retrieve them. Confirm the published catalog/release before reporting public availability.
