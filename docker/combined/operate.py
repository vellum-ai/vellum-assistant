"""Run inside the sandbox to provision credentials and check authenticated chat."""

import argparse
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

from launcher import DATA, KEYS, write_private_json

AUTH = DATA / "supervisor/guardian.json"
DEVICE = "combined-image-smoke"


def request(port, path, body=None, token=None, headers=None):
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    if token:
        request_headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=request_headers,
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def guardian():
    if AUTH.exists():
        auth = json.loads(AUTH.read_text())
        renewed = request(7830, "/v1/guardian/refresh", {
            "refreshToken": auth["refreshToken"], "deviceId": DEVICE,
        }, token=auth["accessToken"])
        auth.update(renewed)
    else:
        keys = json.loads(KEYS.read_text())
        auth = request(7830, "/v1/guardian/init", {
            "platform": "cli", "deviceId": DEVICE, "clientReportedName": "Combined image smoke check",
        }, headers={"x-bootstrap-secret": keys["GUARDIAN_BOOTSTRAP_SECRET"]})
    if not auth.get("accessToken"):
        raise RuntimeError("Guardian authentication did not return an access token.")
    write_private_json(AUTH, auth)
    return auth["accessToken"]


def provision(token, platform_url, api_key):
    if not platform_url.startswith("https://") or not api_key:
        raise RuntimeError("Provisioning requires an HTTPS platform URL and a non-empty API key.")
    ces_token = json.loads(KEYS.read_text())["CES_SERVICE_TOKEN"]
    for field, value in (("platform_base_url", platform_url), ("assistant_api_key", api_key)):
        name = "vellum:" + field
        result = request(7830, "/v1/secrets", {"type": "credential", "name": name, "value": value}, token)
        if result.get("success") is not True:
            raise RuntimeError(f"Credential write was not acknowledged for {field}.")
        stored = request(8090, "/v1/credentials/" + name, token=ces_token)
        if stored.get("value") != value:
            raise RuntimeError(f"CES readback failed for {field}.")
    print("PASS: platform URL and API key stored through the gateway and verified in CES (values hidden).")


def completed_reply(history):
    messages = [message for message in history.get("messages", []) if message.get("role") == "assistant"]
    if any(message.get("providerError") for message in messages):
        raise RuntimeError("The assistant reported a provider error. Check provisioning and model access.")
    if any(message.get("toolCalls") or any(block.get("type") == "tool_use"
           for block in message.get("contentBlocks", [])) for message in messages):
        raise RuntimeError("The response used a tool; this does not pass the no-tool chat check.")
    if history.get("processing") is not False:
        return None
    text = "\n".join(block.get("text", "") for message in messages
                     if not message.get("systemCard") and not message.get("noResponse")
                     for block in message.get("contentBlocks", []) if block.get("type") == "text")
    return text.strip() or None


def smoke(token):
    for bad_token in (None, "invalid"):
        try:
            request(7830, "/v1/conversations", token=bad_token)
        except urllib.error.HTTPError as exc:
            if exc.code not in (401, 403):
                raise
        else:
            raise RuntimeError("Gateway accepted an unauthenticated or invalid-token request.")
    conversation = request(7830, "/v1/conversations", {"title": "Combined image smoke check"}, token)
    conversation_id = conversation["id"]
    request(7830, "/v1/messages", {
        "conversationId": conversation_id, "content": "Reply with exactly COMBINED_OK. Do not use any tools.",
        "sourceChannel": "vellum", "interface": "vellum", "clientMessageId": str(uuid.uuid4()),
    }, token)
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        reply = completed_reply(request(7830, "/v1/messages?conversationId=" + conversation_id, token=token))
        if reply:
            if reply != "COMBINED_OK":
                raise RuntimeError("Completed reply did not match COMBINED_OK. Inspect the conversation.")
            print(f"PASS: authenticated no-tool chat completed; conversation {conversation_id}.")
            return
        time.sleep(1)
    raise RuntimeError("No completed reply within 300s. Message acceptance alone is not success.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("auth", "provision", "smoke"))
    parser.add_argument("--platform-url", default=os.environ.get("VELLUM_PLATFORM_URL", ""))
    parser.add_argument("--key-stdin", action="store_true", help="Read the API key from stdin without echoing it")
    args = parser.parse_args()
    token = guardian()
    if args.action == "provision":
        key = sys.stdin.read().strip() if args.key_stdin else getpass.getpass("Assistant API key: ")
        provision(token, args.platform_url, key)
    elif args.action == "smoke":
        smoke(token)
    else:
        print("PASS: guardian token saved privately (value hidden).")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as exc:
        # Response bodies can include credentials or user content.
        print(f"FAILED: HTTP {exc.code}; inspect service logs locally.", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
