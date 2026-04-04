---
name: oura-setup
description: Connect an Oura Ring via OAuth2 — app registration, token exchange, and credential storage
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "💍"
  vellum:
    display-name: "Oura Ring Setup"
---

# Oura Ring Integration

Connect the user's Oura Ring to pull sleep, heart rate, readiness, activity, and other health data via the Oura Cloud API V2.

## Prerequisites

- An Oura Ring (Gen 3 or Ring 4) with an active Oura Membership ($6/mo required for API access)
- The Oura app installed and paired with the ring
- An Oura Cloud account at https://cloud.ouraring.com

## Setup

### 1. Register a Developer Application

Have the user go to https://developer.ouraring.com/applications and create a new application:

- **Display Name:** The user's preferred name for the integration
- **Description:** Brief description of the integration
- **Contact Email:** User's email
- **Website:** Any valid URL (e.g. a personal website)
- **Privacy Policy / Terms of Service:** Any valid URLs (required fields, not enforced for personal apps)
- **Redirect URIs:** `http://localhost:3000/callback`
- **Scopes:** Enable all scopes needed. Recommended: `personal`, `daily`, `heartrate`, `sleep`, `workout`, `spo2`, `stress`, `heart_health`, `session`, `ring_configuration`

Save the **Client ID** and **Client Secret**.

### 2. Run the OAuth Flow

Store the client secret securely using `credential_store`, then write and run the OAuth helper script on the user's machine:

```python
#!/usr/bin/env python3
"""Oura Ring OAuth2 helper — catches auth code and exchanges for tokens instantly."""
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, urlencode
import urllib.request, json, webbrowser, ssl

CLIENT_ID = 'YOUR_CLIENT_ID'
CLIENT_SECRET = 'YOUR_CLIENT_SECRET'
REDIRECT_URI = 'http://localhost:3000/callback'
SCOPES = 'email personal daily heartrate workout tag session spo2 ring_configuration stress heart_health'

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == '/':
            params = urlencode({
                'response_type': 'code', 'client_id': CLIENT_ID,
                'redirect_uri': REDIRECT_URI, 'scope': SCOPES, 'state': 'assistant'
            })
            self.send_response(302)
            self.send_header('Location', f'https://cloud.ouraring.com/oauth/authorize?{params}')
            self.end_headers()
        elif parsed.path == '/callback':
            code = parse_qs(parsed.query).get('code', [''])[0]
            if code:
                token_data = urlencode({
                    'grant_type': 'authorization_code', 'code': code,
                    'redirect_uri': REDIRECT_URI, 'client_id': CLIENT_ID,
                    'client_secret': CLIENT_SECRET,
                }).encode()
                try:
                    req = urllib.request.Request('https://api.ouraring.com/oauth/token',
                        data=token_data,
                        headers={'Content-Type': 'application/x-www-form-urlencoded'},
                        method='POST')
                    resp = urllib.request.urlopen(req, context=ssl.create_default_context())
                    result = json.loads(resp.read())
                    with open('/tmp/oura_tokens.json', 'w') as f:
                        json.dump(result, f, indent=2)
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html')
                    self.end_headers()
                    self.wfile.write(b'<html><body><h1>Connected! You can close this tab.</h1></body></html>')
                    print(f'\nTokens saved to /tmp/oura_tokens.json')
                except Exception as e:
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(f'Token exchange failed: {e}'.encode())
    def log_message(self, *a): pass

print('Opening browser for Oura authorization...')
webbrowser.open('http://localhost:3000')
HTTPServer(('localhost', 3000), Handler).serve_forever()
```

Run with `python3 /path/to/script.py` on the user's machine (`host_bash`). The user authorizes in their browser, the script catches the code and exchanges it for tokens in under a second.

**Important:** Auth codes expire in ~30 seconds. Do NOT have the user paste codes manually — use this script to catch and exchange them automatically.

### 3. Store Tokens

After the OAuth flow, read tokens from `/tmp/oura_tokens.json` and store them:
- `access_token` — store in credential vault with injection template for `api.ouraring.com` Authorization header (Bearer prefix)
- `refresh_token` — store in credential vault for token refresh
- Tokens expire in ~30 days. Set a reminder to refresh before expiry.

### 4. Verify Connection

Test with the personal info endpoint:
```bash
curl -s -H "Authorization: Bearer $TOKEN" "https://api.ouraring.com/v2/usercollection/personal_info"
```

## Available Endpoints

All endpoints use `GET https://api.ouraring.com/v2/usercollection/{type}` with query params `start_date` and `end_date` (YYYY-MM-DD format).

| Endpoint | Data | Notes |
|----------|------|-------|
| `/v2/usercollection/daily_sleep` | Sleep score, duration, efficiency, stages | Best checked after user's typical wake time |
| `/v2/usercollection/sleep` | Detailed sleep periods with HR, HRV, movement | Raw sleep period data |
| `/v2/usercollection/daily_readiness` | Readiness score, HRV balance, recovery | Good morning check-in metric |
| `/v2/usercollection/daily_activity` | Steps, calories, movement, inactivity | Activity summary |
| `/v2/usercollection/heartrate` | Continuous HR (use `start_datetime`/`end_datetime` in ISO format) | Can be large — limit date range |
| `/v2/usercollection/daily_spo2` | Blood oxygen levels | Nightly average |
| `/v2/usercollection/daily_stress` | Stress score and recovery | Daytime stress tracking |
| `/v2/usercollection/workout` | Detected workouts with HR, calories | Auto-detected or manual |
| `/v2/usercollection/personal_info` | Age, weight, height, email | Good connection test |

## Token Refresh

Tokens expire after 30 days. Refresh with:
```bash
curl -s -X POST "https://api.ouraring.com/oauth/token" \
  -d "grant_type=refresh_token&refresh_token=$REFRESH_TOKEN&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET"
```

Store the new access_token and refresh_token from the response.

## Tips

- New rings need 1-2 nights to calibrate before data is meaningful
- Sleep data typically appears a few hours after the user wakes up
- Heart rate data during workouts appears after the workout syncs via the Oura app
- Rate limit: 5000 requests per 5 minutes
- Ring 4 and Gen 3 users MUST have an active Oura Membership for API access
