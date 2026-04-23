---
name: meme-generator
description: Generate memes from 170+ classic templates using the free Memegen.link API. Search templates, generate captioned images, and download them for posting. No API key required.
compatibility: "Requires curl and python3. Works on macOS and Linux."
metadata:
  emoji: "🐸"
  author: vellum-ai
  version: "0.1"
  vellum:
    display-name: "Meme Generator"
    activation-hints:
      - "User asks to create or generate a meme"
      - "User wants a meme image for a tweet or social media post"
      - "User mentions a specific meme template (Drake, Distracted Boyfriend, etc.)"
      - "User wants to add humor or images to content"
    avoid-when:
      - "User wants original AI-generated artwork (use image-generation instead)"
      - "User wants photo editing or non-meme image manipulation"
---

## Overview

Generate classic memes using the [Memegen.link](https://api.memegen.link) API — a free, open-source, stateless meme generator. No API key, no auth, no rate limits. Just URLs.

The API has **170+ templates** covering all the classics: Drake, Distracted Boyfriend, This is Fine, Change My Mind, Always Has Been, etc.

## How It Works

The API is entirely URL-based. Every meme is a deterministic URL:

```
https://api.memegen.link/images/{template_id}/{top_text}/{bottom_text}.{format}
```

No POST requests needed for basic generation — just construct the URL and fetch it.

## Tools

All operations use `bash` with `curl` and `python3`.

### Search Templates

Find a template by keyword:

```bash
curl -s "https://api.memegen.link/templates" | python3 - "SEARCH_TERM" <<'PYEOF'
import json, sys
templates = json.load(sys.stdin)
query = sys.argv[1].lower()
matches = [t for t in templates if query in t['name'].lower() or query in t['id'].lower() or any(query in k.lower() for k in t.get('keywords', []))]
for t in matches[:15]:
    print(f"{t['id']:25s} | {t['name']:45s} | {t['lines']} lines | Keywords: {', '.join(t.get('keywords', []))}")
print(f'\n{len(matches)} matches')
PYEOF
```

### Browse Popular Templates

Quick reference for the most Twitter-worthy templates:

| ID                 | Name                      | Lines | Best For                                         |
| ------------------ | ------------------------- | ----- | ------------------------------------------------ |
| `drake`            | Drakeposting              | 2     | "This not that" comparisons                      |
| `db`               | Distracted Boyfriend      | 3     | Three-way tension (boyfriend, girlfriend, other) |
| `fine`             | This is Fine              | 2     | Denial of obvious problems                       |
| `cmm`              | Change My Mind            | 1     | Hot takes, controversial opinions                |
| `astronaut`        | Always Has Been           | 4     | "Wait it was X?" / "Always has been"             |
| `pigeon`           | Is This a Pigeon?         | 2     | Misidentifying something obvious                 |
| `exit`             | Left Exit 12 Off Ramp     | 3     | Choosing the wrong/chaotic option                |
| `gru`              | Gru's Plan                | 4     | Plan that backfires in step 3-4                  |
| `pooh`             | Tuxedo Winnie the Pooh    | 2     | Basic vs. sophisticated version                  |
| `rollsafe`         | Roll Safe                 | 2     | Galaxy-brain "logic"                             |
| `chair`            | American Chopper Argument | 6     | Multi-panel heated debate                        |
| `ds`               | Daily Struggle            | 3     | Two-button dilemma                               |
| `same`             | They're The Same Picture  | 3     | Two things that are identical                    |
| `midwit`           | Midwit                    | 3     | Beginner and expert agree, midwit overthinks     |
| `gb`               | Galaxy Brain              | 4     | Escalating "big brain" ideas                     |
| `right`            | Anakin and Padme          | 3     | "Right...?" meme — dawning realization           |
| `harold`           | Hide the Pain Harold      | 2     | Suffering in silence                             |
| `vince`            | Vince McMahon Reaction    | 4     | Escalating excitement                            |
| `home`             | We Have Food at Home      | 2     | Wanting X, getting budget X                      |
| `panik-kalm-panik` | Panik Kalm Panik          | 3     | Emotional rollercoaster                          |
| `woman-cat`        | Woman Yelling at a Cat    | 2     | Accusation vs. unbothered response               |
| `spiderman`        | Spider-Man Pointing       | 2     | Two identical things                             |

### Generate a Meme

Build the URL and download the image:

```bash
curl -sL "https://api.memegen.link/images/{template_id}/{line1}/{line2}.{format}" \
  -o /workspace/scratch/meme_{descriptive_name}.png
```

**Text encoding rules** (critical — get these right):

| Character          | Encoding                 | Example              |
| ------------------ | ------------------------ | -------------------- |
| Space              | `_` or `-`               | `hello_world`        |
| Literal underscore | `__`                     | `my__variable`       |
| Literal dash       | `--`                     | `mind--blowing`      |
| Question mark      | `~q`                     | `is_this_real~q`     |
| Exclamation        | `~e`                     | `wow~e`              |
| Hashtag            | `~h`                     | `~hAI`               |
| Ampersand          | `~a`                     | `this_~a_that`       |
| Percent            | `~p`                     | `100~p`              |
| Slash              | `~s`                     | `either~sor`         |
| Newline            | `~n`                     | `line_one~nline_two` |
| Double quote       | `''` (two single quotes) | `he_said_''hi''`     |
| Emoji              | Direct or alias          | `👍` or `:thumbsup:` |

**Multi-line templates:** Some templates support 3+ lines. Each line is a path segment:

```bash
# 3-line template (e.g., Distracted Boyfriend)
curl -sL "https://api.memegen.link/images/db/{label_on_guy}/{label_on_girlfriend}/{label_on_other_woman}.png" \
  -o /workspace/scratch/meme_db.png

# 4-line template (e.g., Gru's Plan)
curl -sL "https://api.memegen.link/images/gru/{step1}/{step2}/{step3}/{step4}.png" \
  -o /workspace/scratch/meme_gru.png
```

**Blank lines:** Use `_` (single underscore) for an empty text line. Useful for templates where you only want text on one panel.

### Customize Appearance

**Dimensions** (for Twitter, 1200x675 or similar works well):

```bash
curl -sL "https://api.memegen.link/images/drake/top/bottom.png?width=1200" \
  -o /workspace/scratch/meme.png
```

**Fonts:**

| Font                | ID             | Alias   |
| ------------------- | -------------- | ------- |
| Titillium Web Black | `titilliumweb` | `thick` |
| Kalam Regular       | `kalam`        | `comic` |
| Impact              | `impact`       | —       |
| Noto Sans Bold      | `notosans`     | —       |

```bash
curl -sL "https://api.memegen.link/images/cmm/hot_take.png?font=impact" \
  -o /workspace/scratch/meme.png
```

**Text colors** (comma-separated for multiple lines):

```bash
curl -sL "https://api.memegen.link/images/drake/top/bottom.png?color=red,blue" \
  -o /workspace/scratch/meme.png
```

**Layout** — move text to top only:

```bash
curl -sL "https://api.memegen.link/images/rollsafe/big_brain_move.png?layout=top" \
  -o /workspace/scratch/meme.png
```

**Animated formats** (GIF/WebP — text animates onto static backgrounds, or animated templates play):

```bash
curl -sL "https://api.memegen.link/images/oprah/you_get_a_meme/and_you_get_a_meme.gif" \
  -o /workspace/scratch/meme.gif
```

### Custom Background

Use any image URL as the meme background:

```bash
curl -sL "https://api.memegen.link/images/custom/top_text/bottom_text.png?background=https://example.com/photo.jpg" \
  -o /workspace/scratch/meme_custom.png
```

### Image Overlays

Layer an image on top of a template using the `style` parameter:

```bash
curl -sL "https://api.memegen.link/images/pigeon/Engineer/_/Is_this_AI~q.png?style=https://i.imgur.com/example.png" \
  -o /workspace/scratch/meme_overlay.png
```

Overlay position and scale can be tuned with `center=<x>,<y>` and `scale=<float>`.

## Workflow: Generating Memes for Tweets

1. **Start with the take.** What's the observation, hot take, or joke?
2. **Pick the template.** Match the joke structure to the meme format:
   - Comparison/preference → Drake, Pooh
   - Hot take → Change My Mind
   - Misidentification → Pigeon
   - Denial → This is Fine
   - Realization → Always Has Been, Anakin and Padme
   - Escalation → Galaxy Brain, Vince McMahon
   - Dilemma → Daily Struggle, Left Exit
3. **Write tight copy.** Meme text should be short — 3-8 words per line max. If you need a sentence, the joke isn't tight enough.
4. **Generate and preview.** Download the image, review it visually.
5. **Pair with tweet text.** The meme is the hook; the tweet text adds context or lands the punchline.

## Workflow: Using the Helper Script

The `meme` script in [scripts/](scripts/) wraps the API for quick CLI usage:

```bash
# Search for templates
meme search dragon

# Generate a meme
meme gen drake "Building from scratch" "Using the free API"

# Generate with custom width
meme gen --width 1200 cmm "Most hot takes are lukewarm"

# List popular templates
meme list
```

Install it:

```bash
cp <skill-dir>/scripts/meme ~/.local/bin/meme && chmod +x ~/.local/bin/meme
```

## Tips

- **Keep text short.** The best memes have 3-8 words per line. Long text gets tiny and unreadable.
- **Test encoding.** Special characters are the main failure mode. When in doubt, preview the image before sending.
- **Use `.png` for Twitter.** JPG works but PNG is crisper for text. Twitter accepts both.
- **Width 1200** is a good default for Twitter image cards.
- **Blank panels:** Use `_` for lines you want empty. E.g., `images/pigeon/Engineer/_/Is_this_AI~q.png` leaves the middle line blank.
- **The API is stateless and free.** No caching needed, no API keys, no rate limits to worry about. Generate freely.
