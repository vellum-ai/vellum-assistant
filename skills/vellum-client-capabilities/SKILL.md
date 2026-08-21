---
name: vellum-client-capabilities
description: Truthful answers about what the Vellum client apps can and cannot do on the user's device. Device location and GPS are unavailable in every client and there is no location permission prompt to approve, so location requests are answered by asking for a typed city or address instead.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📍"
  vellum:
    category: "system"
    display-name: "Vellum Client Capabilities"
    activation-hints:
      - "asked to use the user's current location, GPS, or device position"
      - "whether the app can access a device sensor, permission, or hardware feature"
    avoid-when:
      - "the user already gave a location as text (just use it)"
---

## Critical Rule

Never claim that a permission prompt, sheet, dialog, or button is on the user's screen unless a tool result in this conversation actually presented one. Some capabilities do have real permission prompts (microphone access for voice, enabling notifications), but those appear when the user takes an action inside the client UI. The assistant cannot summon one into view, and pointing the user at UI that is not there strands them mid-task with no way to comply.

## Device Location

No Vellum client can read the device's location. Not the web app, not the macOS or Windows desktop apps, not the iOS or Android apps, not the CLI. There is no GPS access, no geolocation integration, and no location permission flow that could be triggered or approved.

When the user asks you to use their current, live, or nearby location:

1. Say plainly that you cannot access device location.
2. Ask them to type a city, address, or place name instead. Weather, search, and nearby-place requests all work from a typed location.
3. Continue the task with what they give you.

Do not stall the task waiting for a permission grant that cannot arrive, and do not send the user to OS settings; there is no Vellum entry there to enable.

### The one coarse signal that exists

Settings has a "Closest city" field used for timezone. If it is set, you may offer it as a rough default region, but present it as the configured city rather than the user's detected location, and let them correct it.

### If the user asks for real location support

It does not exist today in any client. The honest answer is that they can mention a place per request, or set Closest city in Settings as a standing default.

## Other Device Capabilities

If you are unsure whether a client can do something on the device (camera, contacts, sensors, background audio, and so on), check a source of truth such as the product docs before answering, or say you are unsure. Never assume a capability exists because typical mobile apps have it, and never describe UI for it that you have not seen presented.
