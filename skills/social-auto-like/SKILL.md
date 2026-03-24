---
name: social-auto-like
description: Automatically like Twitter/X posts shared in Slack channels in real-time
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "❤️"
  vellum:
    display-name: "Social Auto-Like"
    includes:
      - "twitter"
---

## Purpose

When a message arrives in a Slack channel containing a Twitter/X link, automatically like that tweet and leave a reaction emoji on the Slack message as visual confirmation.

## Channel Scoping

Auto-liking applies to all Slack channels the bot is a member of. To restrict which channels are auto-liked, control which channels the Slack bot is added to.

## Behavior

When you receive an inbound Slack message:

1. If the message contains any `twitter.com` or `x.com` status URLs, call `twitter_auto_like_scan` with the full message text
2. The tool handles everything: extracting URLs, liking each tweet, and adding a reaction emoji to the original Slack message
3. Do not call any other tools for the reaction — the scan tool handles it internally

## Trust Requirements

- **Guardian**: Full auto-approve
- **Trusted contacts**: Auto-approve via `trusted_auto_approve` flag (all tools are low-risk). People who post in the channel should be added as trusted contacts.
- **Unknown actors**: Tool execution blocked. Message silently not processed.

## Prerequisites

- Twitter/X OAuth connected (see `twitter-oauth-setup`)
- Slack connected (see `slack-app-setup`)
- Bot must be a member of the target channel
- Posters should be trusted contacts
