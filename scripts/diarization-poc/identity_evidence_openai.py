#!/usr/bin/env python3
"""
Provider-driven identity evidence extraction from diarized segments.

This intentionally avoids hardcoded local regex rules for identity phrases.
"""

from __future__ import annotations

import json
import time
from typing import Any

import requests


def infer_identity_evidence(
    segments: list[dict[str, Any]],
    api_key: str,
    model: str = "gpt-4o-mini",
    max_retries: int = 3,
) -> dict[str, Any]:
    prompt = (
        "You are extracting speaker-identity evidence from a diarized transcript.\n"
        "Return strict JSON only with an `evidence` array.\n"
        "Each evidence item must be:\n"
        "{\n"
        "  \"source_speaker\": string,          // speaker label in transcript, e.g. speaker_0\n"
        "  \"target_speaker\": string|null,     // who the name likely belongs to; null if unknown\n"
        "  \"candidate_name\": string,          // proper-cased person name candidate\n"
        "  \"relation\": \"self\"|\"addressing\"|\"third_party\"|\"uncertain\",\n"
        "  \"confidence\": number,              // 0..1\n"
        "  \"rationale\": string\n"
        "}\n"
        "Important:\n"
        "- You may infer identity from people addressing each other naturally.\n"
        "- Do not invent people not grounded in transcript context.\n"
        "- If ambiguous, lower confidence and/or use relation='uncertain'.\n"
        "- Keep names concise (person names only).\n"
    )

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": prompt}]},
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": json.dumps({"segments": segments}, ensure_ascii=True),
                    }
                ],
            },
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "identity_evidence",
                "schema": {
                    "type": "object",
                    "properties": {
                        "evidence": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "source_speaker": {"type": "string"},
                                    "target_speaker": {"type": ["string", "null"]},
                                    "candidate_name": {"type": "string"},
                                    "relation": {
                                        "type": "string",
                                        "enum": ["self", "addressing", "third_party", "uncertain"],
                                    },
                                    "confidence": {"type": "number"},
                                    "rationale": {"type": "string"},
                                },
                                "required": [
                                    "source_speaker",
                                    "target_speaker",
                                    "candidate_name",
                                    "relation",
                                    "confidence",
                                    "rationale",
                                ],
                                "additionalProperties": False,
                            },
                        }
                    },
                    "required": ["evidence"],
                    "additionalProperties": False,
                },
            }
        },
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    for attempt in range(1, max_retries + 1):
        resp = requests.post(
            "https://api.openai.com/v1/responses",
            headers=headers,
            json=payload,
            timeout=120,
        )
        if resp.status_code < 300:
            obj = resp.json()
            text = obj.get("output_text")
            if not isinstance(text, str) or not text.strip():
                return {"evidence": []}
            parsed = json.loads(text)
            if isinstance(parsed, dict) and isinstance(parsed.get("evidence"), list):
                return parsed
            return {"evidence": []}

        if attempt == max_retries:
            raise RuntimeError(f"identity inference failed {resp.status_code}: {resp.text}")
        time.sleep(min(12, 2 ** (attempt - 1)))

    return {"evidence": []}
