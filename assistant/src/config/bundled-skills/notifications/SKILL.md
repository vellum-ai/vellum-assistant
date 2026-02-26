---
name: "Notifications"
description: "Send notifications through the unified notification router"
user-invocable: true
metadata: {"vellum": {"emoji": "\ud83d\udd14"}}
---

Use `send_notification` for user-facing alerts and notifications. This tool routes through the unified notification pipeline, which handles channel selection, delivery, deduplication, and audit logging.

## Routing Behavior

- `preferred_channels` are **routing hints**, not hard channel forcing. The notification router makes the final delivery decision based on user preferences, channel availability, and urgency.
- Channel selection and delivery are handled entirely by the notification router -- do not attempt to control delivery manually.

## Important

- Do **NOT** use AppleScript `display notification` or other OS-level notification commands for assistant-managed alerts. Always use `send_notification`.
- For sending messages into a specific chat, email, or SMS destination, use the messaging skill's `messaging_send` instead.

## Querying Delivery History

Use the runtime HTTP API to query notification delivery summaries. The endpoint returns delivery records with interaction tracking (seen/viewed status).

```bash
# List recent deliveries for this assistant
curl -s -H "Authorization: Bearer $(cat ~/.vellum/http-token)" \
  "http://localhost:7821/v1/notifications/deliveries?assistantId=self&limit=50"

# Paginate through older deliveries
curl -s -H "Authorization: Bearer $(cat ~/.vellum/http-token)" \
  "http://localhost:7821/v1/notifications/deliveries?assistantId=self&limit=20&offset=20"
```

Each delivery record includes: `deliveryId`, `assistantId`, `channel`, `destination`, `status`, `seenAt`, `viewedAt`, `lastInteractionType`, `lastInteractionAt`, `sentAt`, `createdAt`, and `conversationId`.
