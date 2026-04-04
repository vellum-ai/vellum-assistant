---
name: fish-audio
description: "Generate expressive audio clips using Fish Audio S2 TTS with bracket emotion tags. Record voice memos, narration, audio messages, or any spoken content."
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎙️"
  vellum:
    display-name: "Fish Audio TTS"
---

# Fish Audio TTS

Generate expressive audio clips using the Fish Audio S2 TTS API with `[bracket]` emotion tags.

## Overview

This skill lets you create audio clips on demand — narration, announcements, podcast intros, dramatic readings, voice memos, or any spoken content. Uses Fish Audio S2 Pro with the full bracket syntax for emotional expressiveness.

## Configuration

- **API Endpoint:** `https://api.fish.audio/v1/tts`
- **Model:** `s2-pro`
- **Voice Reference ID:** Configured via `assistant config get fishAudio.referenceId`
- **API Key:** Stored as credential `fish-audio/api_key`
- **Default Format:** `mp3` at 192kbps
- **Default Output Directory:** `scratch/`

## API Key Setup

The Fish Audio API key must be stored securely via the credential store. Get an API key from the Fish Audio dashboard at https://fish.audio.

Check if the key is already configured:

```bash
assistant credentials inspect --service fish-audio --field api_key --json
```

If not set, collect it securely (never ask the user to paste it in chat):

```
credential_store action="prompt" service="fish-audio" field="api_key" label="Fish Audio API Key" description="Enter your Fish Audio API key" placeholder="sk-..."
```

## Generating a Single Clip

Use `bash` with `curl` to call the Fish Audio API:

```bash
curl -s -X POST "https://api.fish.audio/v1/tts" \
  -H "Authorization: Bearer $(assistant credentials reveal --service fish-audio --field api_key)" \
  -H "Content-Type: application/json" \
  -H "model: s2-pro" \
  -d '{
    "text": "YOUR TEXT WITH [bracket] TAGS HERE",
    "reference_id": "'"$(assistant config get fishAudio.referenceId)"'",
    "format": "mp3",
    "mp3_bitrate": 192,
    "temperature": 0.8
  }' --output scratch/OUTPUT_FILENAME.mp3
```

**Important:** This API call requires network access. Always use `network_mode: proxied` when running this command.

## Generating Multiple Clips & Combining

For longer pieces (narrations, multi-part messages), generate each clip separately then combine with ffmpeg:

### 1. Generate silence for gaps between clips

```bash
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1.5 -q:a 9 -acodec libmp3lame scratch/silence.mp3 -y
```

### 2. Create a concat file

```bash
cat > scratch/concat.txt << 'EOF'
file 'scratch/clip1.mp3'
file 'scratch/silence.mp3'
file 'scratch/clip2.mp3'
file 'scratch/silence.mp3'
file 'scratch/clip3.mp3'
EOF
```

### 3. Combine

```bash
ffmpeg -f concat -safe 0 -i scratch/concat.txt -c copy scratch/final_output.mp3 -y
```

## Bracket Syntax — Complete Guide

Fish Audio S2 uses `[bracket]` syntax for inline emotion and prosody control. This is the core of what makes the voice expressive. Tags are natural-language instructions placed directly in the text that control how words are spoken — the delivery, emotion, pacing, or vocal quality at that exact point.

**Key principle:** You are not choosing from a fixed menu. You write the description, and S2 interprets it. If you can describe it to a voice actor, S2 can attempt it. Over 15,000+ unique tags are supported, and the system understands free-form descriptions.

### How Placement Works

Tags affect what comes **after** them. Place the tag at the **exact point** where the shift should happen. Placement IS meaning.

```
[whispering] I didn't want to go inside.     <- whispers the entire line
I didn't want to go [whispering] inside.     <- only whispers from "inside" onward
```

Tags can go **anywhere** — start, middle, or end of a sentence. They apply from the point they appear until the next tag or end of the sentence.

### Well-Tested Tags (Reliable Out of the Box)

These tags consistently produce strong results. Organized by category:

#### Emotions

| Tag             | Effect                  | Best For                    |
| --------------- | ----------------------- | --------------------------- |
| `[happy]`       | Cheerful, upbeat        | Good news, greetings        |
| `[sad]`         | Melancholic, downcast   | Sympathy, vulnerability     |
| `[angry]`       | Frustrated, aggressive  | Arguments, complaints       |
| `[excited]`     | Energetic, enthusiastic | Celebrations, announcements |
| `[surprised]`   | Shocked, amazed         | Reactions, discoveries      |
| `[embarrassed]` | Awkward, flustered      | Mistakes, confessions       |
| `[delight]`     | Very pleased, joyful    | Genuine happiness           |
| `[nervous]`     | Anxious, uncertain      | Vulnerability, apologies    |
| `[confident]`   | Assertive, self-assured | Bold statements             |
| `[nostalgic]`   | Longing for the past    | Memories, stories           |
| `[scared]`      | Frightened, fearful     | Warnings, tension           |
| `[jealous]`     | Envious, resentful      | Comparisons, possessiveness |
| `[shocked]`     | Sudden realization      | Dramatic reveals            |
| `[moved]`       | Emotionally touched     | Heartfelt moments           |

#### Voice Quality & Style

| Tag                    | Effect                | Best For                     |
| ---------------------- | --------------------- | ---------------------------- |
| `[soft]`               | Gentle, tender        | Intimate moments, kindness   |
| `[whisper]`            | Very quiet, close     | Secrets, tension, suspense   |
| `[breathy]`            | Airy, expressive      | Vulnerability, emphasis      |
| `[low voice]`          | Deep, quiet register  | Gravity, seriousness         |
| `[loud]`               | Raised volume         | Emphasis, excitement         |
| `[screaming]`          | Full volume yelling   | Anger, extreme excitement    |
| `[shouting]`           | Forceful projection   | Arguments, calling out       |
| `[emphasis]`           | Stressed delivery     | Key words, making a point    |
| `[singing]`            | Musical quality       | Playfulness, joy             |
| `[echo]`               | Reverberant effect    | Dramatic moments             |
| `[with strong accent]` | Pronounced accent     | Character work               |

#### Paralinguistic Sounds (Non-Speech Vocalizations)

| Tag                 | Effect                 | Best For                         |
| ------------------- | ---------------------- | -------------------------------- |
| `[laughing]`        | Full laugh             | Joy, humor, warmth               |
| `[chuckling]`       | Soft, low laugh        | Warmth, amusement                |
| `[giggling]`        | Light, playful laugh   | Lightheartedness, delight        |
| `[sigh]`            | Audible exhale         | Relief, longing, exasperation    |
| `[inhale]`          | Audible breath in      | Before speaking, anticipation    |
| `[exhale]`          | Breath out             | Relief, settling                 |
| `[panting]`         | Heavy breathing        | Exertion, intensity              |
| `[gasp]`            | Sharp intake of breath | Surprise, shock                  |
| `[tsk]`             | Disapproving click     | Judgment, disapproval            |
| `[clearing throat]` | Ahem                   | Transitioning, getting attention |
| `[moaning]`         | Vocal moan             | Pain, frustration                |
| `[sobbing]`         | Crying with voice      | Deep sadness                     |
| `[crying loudly]`   | Full crying            | Extreme emotion                  |

#### Pacing & Rhythm

| Tag             | Effect                     | Best For                               |
| --------------- | -------------------------- | -------------------------------------- |
| `[pause]`       | Brief silence (~0.5-1s)    | Beat between thoughts                  |
| `[short pause]` | Quick beat (~0.3s)         | Rhythm, emphasis                       |
| `[long pause]`  | Extended silence (~1.5-2s) | Dramatic tension, letting moments land |

#### Volume Control

| Tag             | Effect             | Best For           |
| --------------- | ------------------ | ------------------ |
| `[volume up]`   | Gradually louder   | Building energy    |
| `[volume down]` | Gradually quieter  | Drawing someone in |
| `[low volume]`  | Consistently quiet | Background, aside  |

### Free-Form Tags (The Real Power)

You are NOT limited to the tags above. S2 accepts **any natural language description** in brackets. The model generalizes from its training data to interpret novel instructions. Write what you would tell a voice actor:

#### Compound Emotions

- `[laughing nervously]`
- `[angry but trying to stay calm]`
- `[happy with a hint of sadness]`
- `[excited but whispering]`
- `[voice rough from crying, trying to sound normal]`

#### Specific Delivery Styles

- `[professional broadcast tone]`
- `[speaking slowly, almost hesitant]`
- `[whispering like a secret]`
- `[dead tired, end of a very long shift]`
- `[the calm, measured tone of someone who has done this a thousand times]`
- `[overly cheerful, clearly forcing it]`

#### Prosody & Pitch

- `[pitch up]`
- `[pitch down]`
- `[speaking slowly with warmth]`
- `[speaking quickly with excitement]`
- `[pitch up slightly while maintaining warmth]`
- `[trailing off]`

#### Character Directions

- `[voice breaking]`
- `[barely holding it together]`
- `[soft voice]`
- `[interrupting]`
- `[laughing tone]` (speaking while laughing, not just a laugh)
- `[excited tone]` (speaking with excitement woven through)

### Writing Great Scripts — Best Practices

#### 1. Start Simple, Then Layer

A single well-placed `[sigh]` or `[long pause]` can change a line completely. Add more tags only when the simpler version is not enough. Over-tagging competes with itself.

**Too many tags (competing):**

```
[soft] [whisper] [sad] [slow] I miss the old days.
```

**Better — one well-chosen tag:**

```
[nostalgic] I miss the old days.
```

#### 2. Use Emotional Contrast for Impact

The most powerful moments come from sudden shifts. Going from loud to soft, angry to vulnerable, laughing to serious — the contrast is what creates emotional impact.

```
[screaming] I can't BELIEVE you did that! [long pause] [soft] ...do you even care?
```

```
[excited] Oh my god we got the apartment! [pause] [voice breaking] I can't believe it's actually happening.
```

#### 3. Let Silence Do the Work

`[pause]` and `[long pause]` are your most powerful tags. Use them:

- Before something vulnerable
- After something that needs to land
- Before a punchline or tonal shift
- To create tension or anticipation

```
[confident] I have an announcement to make. [long pause] [excited] We did it. We actually did it.
```

#### 4. Paralinguistic Sounds Add Humanity

Real people laugh, sigh, gasp, and breathe between words. Weaving these in makes speech feel alive rather than read.

```
[sigh] Look, I know this is hard. [pause] [inhale] But we need to talk about it.
```

```
I told him the news and he just — [laughing] he literally dropped his coffee.
```

#### 5. Match Tag Intensity to Content

Do not use `[screaming]` for mild annoyance or `[sobbing]` for minor disappointment. The tag should match the emotional weight of the words.

#### 6. Use Free-Form Tags for Nuance

When a single-word tag is not enough, describe the exact delivery you want:

```
[speaking slowly, choosing each word carefully] I think we should reconsider our approach.
```

This gives S2 much richer information than just `[slow]` or `[sad]`.

#### 7. Emotion Transitions Within a Single Passage

S2 excels at dynamic emotional shifts. Use this for natural-feeling monologues:

```
[excited] I got the promotion! [pause] [uncertain] But... it means relocating. [sad] I'll miss everyone here. [long pause] [hopeful] Maybe it'll be worth it though.
```

### Example Scripts

**Narration (audiobook style):**

```
[soft] The city was quiet that morning. [pause] Not the peaceful kind of quiet — [long pause] [low voice] the kind that makes you hold your breath. [inhale] [whisper] Something was about to change. [pause] [confident] And everyone knew it.
```

**Podcast intro:**

```
[excited] Welcome back to another episode! [pause] [professional broadcast tone] Today we're diving into something I've been researching for months. [chuckling] And honestly? It blew my mind. [pause] [volume down] [speaking slowly with warmth] So grab your coffee, get comfortable, and let's get into it.
```

**Dramatic reading:**

```
[soft] She stood at the edge of the platform, [pause] watching the last train pull away. [long pause] [voice breaking] It wasn't supposed to end like this. [sigh] [whisper] None of it was. [pause] [angry but trying to stay calm] And yet here she stood — [emphasis] alone — [long pause] [nostalgic] remembering a time when the station was full of laughter.
```

**Announcement:**

```
[confident] Attention everyone. [pause] [excited] After three years of development, [volume up] we are thrilled to announce [emphasis] the official launch! [long pause] [laughing] I know, I know — it's been a long time coming. [pause] [soft] But we wanted to get it right. [pause] [professional broadcast tone] And we did.
```

## API Parameters

| Parameter      | Default            | Description                                   |
| -------------- | ------------------ | --------------------------------------------- |
| `text`         | (required)         | The text to synthesize, with [bracket] tags   |
| `reference_id` | (from config)      | Voice model ID                                |
| `format`       | `mp3`              | Output format: `mp3`, `wav`, `pcm`, `opus`    |
| `mp3_bitrate`  | `192`              | MP3 quality: `64`, `128`, `192`               |
| `temperature`  | `0.8`              | Expressiveness (higher = more varied)         |
| `top_p`        | `0.7`              | Diversity via nucleus sampling                |
| `chunk_length` | `300`              | Text segment size (100-300)                   |
| `latency`      | `normal`           | Quality tradeoff: `normal`, `balanced`, `low` |

## Tips

- **Temperature 0.7-0.8** works best for expressive, natural speech
- **Break long texts into multiple clips** — each clip should be a natural paragraph or thought
- **Add 1-1.5s silence between clips** when combining for natural pacing
- **Listen and iterate** — generate a few takes with different temperatures if the first one does not hit right
- **The voice carries context** — `condition_on_previous_chunks: true` (default) helps maintain consistency within a single API call
- Always deliver the final audio to the user with `<vellum-attachment>` tags
- Only use `[bracket]` syntax inside text passed to the Fish Audio API, not in regular text responses
