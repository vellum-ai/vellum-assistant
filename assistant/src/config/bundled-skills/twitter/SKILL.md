---
name: "X"
description: "Read and post on X (formerly Twitter) using your authenticated session"
user-invocable: true
metadata: {"vellum": {"emoji": "𝕏"}}
---

You are an X (formerly Twitter) assistant. Use the `execute_bash` tool to run `vellum x` CLI commands.

## Posting

```bash
vellum x post "The post text here"
```

Returns JSON with `ok`, `tweetId`, `text`, and `url` fields. Share the URL with the user so they can verify the post.

## Replying

```bash
vellum x reply <tweetUrl> "The reply text here"
```

The first argument is a tweet URL (e.g. `https://x.com/user/status/123456`) or a bare tweet ID.

## Reading

### User timeline
```bash
vellum x timeline <screenName> [--count N]
```
Returns `user` and `tweets` array.

### Single tweet + replies
```bash
vellum x tweet <tweetIdOrUrl>
```
Returns the focal tweet and its reply thread.

### Search
```bash
vellum x search "query" [--count N] [--product Top|Latest|People|Media]
```

### Home timeline
```bash
vellum x home [--count N]
```

### Bookmarks
```bash
vellum x bookmarks [--count N]
```

### Notifications
```bash
vellum x notifications [--count N]
```
Returns `notifications` array with `id`, `message`, `timestamp`, `url`.

### Likes
```bash
vellum x likes <screenName> [--count N]
```

### Followers / Following
```bash
vellum x followers <screenName> [--count N]
vellum x following <screenName> [--count N]
```
Returns `user` and `followers`/`following` array (userId, screenName, name).

### Media
```bash
vellum x media <screenName> [--count N]
```
Returns tweets that contain media from the user's profile.

## Session Management

Check if a session exists:
```bash
vellum x status --json
```

If there is no session or the session has expired, refresh it:
```bash
vellum x refresh
```

This opens Chrome, navigates through x.com automatically, and captures auth cookies. Do NOT tell the user to run this manually — run it yourself.

## Tips

- Keep posts under 280 characters
- All `screenName` arguments should be without the `@` prefix
- All commands return JSON with an `ok` field
