---
name: oura
description: Pull sleep, activity, readiness, heart rate, and other health data from a connected Oura Ring via the Oura Cloud API V2
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💍"
  vellum:
    display-name: "Oura Ring"
    includes:
      - oura-setup
---

# Oura Ring — Data Access

Pull sleep, activity, readiness, heart rate, and other health data from a connected Oura Ring via the Oura Cloud API V2.

**For initial setup (OAuth, app registration, token exchange), see the `oura-setup` skill.**

## Prerequisites

- Oura Ring already connected via OAuth (see `oura-setup` skill)
- Credential stored: `oura` / `access_token` with injection template for `api.ouraring.com` (Authorization header, Bearer prefix)
- Credential ID can be found via `credential_store` list action, filtering for service `oura`, field `access_token`

## Making Requests

All requests go through the credential proxy — no need to manually attach tokens.

```bash
curl -s "https://api.ouraring.com/v2/usercollection/{endpoint}?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD"
```

Run via `bash` with:
- `network_mode: "proxied"`
- `credential_ids: ["<oura access_token credential_id>"]`

## Endpoints

| Endpoint | What It Returns | Best For |
|----------|----------------|----------|
| `personal_info` | Age, weight, height, email | Connection test |
| `daily_sleep` | Sleep score, duration, efficiency, stages | Morning check-in |
| `sleep` | Detailed sleep periods — HR, HRV, movement, timestamps | Deep sleep analysis |
| `daily_readiness` | Readiness score, HRV balance, recovery index | Morning readiness |
| `daily_activity` | Steps, calories, movement, MET data, activity score | Daily activity summary |
| `heartrate` | Continuous HR readings (uses `start_datetime`/`end_datetime` ISO format) | Workout HR, resting HR |
| `workout` | Detected workouts — HR, calories, duration, type | Exercise tracking |
| `daily_spo2` | Blood oxygen (SpO2) nightly average | Breathing/oxygen |
| `daily_stress` | Stress score, recovery periods | Stress monitoring |
| `ring_configuration` | Ring model, firmware, color, design | Ring info |

## Query Parameters

- **Most endpoints:** `start_date` and `end_date` in `YYYY-MM-DD` format
- **Heart rate:** Uses `start_datetime` and `end_datetime` in ISO 8601 format (e.g. `2025-01-15T00:00:00-05:00`)
- **Personal info / ring config:** No date params needed
- Omitting dates usually returns recent data (last 1-7 days depending on endpoint)

## Common Patterns

### Morning health check
Pull sleep + readiness + activity for today:
```bash
DATE=$(date +%Y-%m-%d)
curl -s "https://api.ouraring.com/v2/usercollection/daily_sleep?start_date=$DATE&end_date=$DATE"
curl -s "https://api.ouraring.com/v2/usercollection/daily_readiness?start_date=$DATE&end_date=$DATE"
```

### Workout details with HR
```bash
YESTERDAY=$(date -v-1d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)
curl -s "https://api.ouraring.com/v2/usercollection/workout?start_date=$YESTERDAY&end_date=$TODAY"
```

### Heart rate during a specific window
```bash
# Adjust the datetime range as needed (ISO 8601 with timezone offset)
curl -s "https://api.ouraring.com/v2/usercollection/heartrate?start_datetime=YYYY-MM-DDT23:00:00-05:00&end_datetime=YYYY-MM-DDT01:00:00-05:00"
```

## Notes

- New rings need **1-2 nights** to calibrate before sleep/readiness scores are meaningful
- Sleep data appears a few hours after waking
- Short workouts (<15 min) may not be auto-detected — check raw heart rate instead
- Heart rate endpoint can return large datasets — keep time windows tight
- Rate limit: 5,000 requests per 5 minutes
- Tokens expire after ~30 days. Refresh using the `oura-setup` skill's token refresh instructions.

## Token Refresh

When the access token expires, use the refresh token via the `oura-setup` skill:

```bash
curl -s -X POST "https://api.ouraring.com/oauth/token" \
  -d "grant_type=refresh_token&refresh_token=REFRESH_TOKEN&client_id=CLIENT_ID&client_secret=CLIENT_SECRET"
```

Store the new access_token and refresh_token. See `oura-setup` for full details.
