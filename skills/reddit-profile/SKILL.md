---
name: "Reddit Profile Import"
description: "Ingest a Reddit user's public post and comment history to initialize the assistant's personality model and memory with interests, preferences, and communication style"
metadata: {"vellum": {"emoji": "🤖"}}
user-invocable: true
---

Analyze a Reddit user's public activity to bootstrap the assistant's memory with rich personality context — interests, communication style, preferences, and recurring topics.

## How to guide the user

When a user wants to initialize the assistant's memory from their Reddit profile:

1. **Ask for their Reddit username.** You only need their username — no credentials are required. The import reads only public data.
2. **Confirm they're okay with the import.** Let them know you'll be fetching their public posts and comments (up to 100 of each) and using that to initialize memory.
3. **Run the import.** Call `reddit_profile_ingest` with their username. This will:
   - Fetch their recent posts and comments from Reddit's public API
   - Analyze the content to extract interests, personality traits, writing style, and preferences
   - Write these as memory items so future conversations are immediately personalized
4. **Report back.** Tell the user how many memory items were created and give a brief summary of what was learned about them.

## What gets extracted

From a user's public Reddit history, the skill extracts:

- **Profile facts**: Account age, activity level, top subreddits they participate in
- **Interests & hobbies**: Topics they post/comment about most (gaming, cooking, programming, etc.)
- **Opinions & viewpoints**: Stances on topics they engage with
- **Communication style**: Writing tone, vocabulary, formality level, humor patterns
- **Preferences**: Inferred from engagement patterns (preferred platforms, tools, media, etc.)

## Notes

- Only public Reddit data is accessed — no authentication or credentials required.
- Fetches up to 100 posts and 100 comments (Reddit API limit per request).
- Deleted/removed posts and private subreddits are not accessible.
- All extracted items use `user_reported` verification state (sourced from the user's own words).
- Re-running the import is safe — existing memory items are deduplicated by fingerprint.
- The user's Reddit username is stored as a profile memory item for future reference.
