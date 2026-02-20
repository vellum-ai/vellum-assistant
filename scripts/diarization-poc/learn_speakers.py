#!/usr/bin/env python3
"""
Learn speaker identities over time from diarized transcripts + audio.

Behavior:
- Speakers start as anonymous aliases (Person 001, Person 002, ...)
- Voice embeddings are matched against a persistent registry
- Names are promoted only after enough evidence accumulates
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import wave
from dataclasses import dataclass
from typing import Any

import numpy as np
from resemblyzer import VoiceEncoder


@dataclass
class Segment:
    speaker: str
    start: float
    end: float
    text: str


def now_iso() -> str:
    return dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return -1.0
    return float(np.dot(a, b) / denom)


def load_json(path: pathlib.Path, default: dict[str, Any]) -> dict[str, Any]:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: pathlib.Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def parse_segments(obj: dict[str, Any]) -> list[Segment]:
    out: list[Segment] = []
    raw_segments = obj.get("segments")
    if isinstance(raw_segments, list):
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            speaker = str(item.get("speaker") or item.get("speaker_label") or "unknown")
            start = float(item.get("start") or 0.0)
            end = float(item.get("end") or start)
            text = str(item.get("text") or "").strip()
            if end > start:
                out.append(Segment(speaker=speaker, start=start, end=end, text=text))
    return out


def read_wav_mono_16k(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        sample_rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError(f"{path} is not 16-bit PCM")
    data = np.frombuffer(raw, dtype=np.int16)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1).astype(np.int16)
    if sample_rate != 16000:
        raise ValueError(f"{path} expected 16kHz, got {sample_rate}")
    return data.astype(np.float32) / 32768.0


def slice_audio(audio: np.ndarray, start_s: float, end_s: float, sr: int = 16000) -> np.ndarray:
    i0 = max(0, int(start_s * sr))
    i1 = min(len(audio), int(end_s * sr))
    return audio[i0:i1]


def create_registry() -> dict[str, Any]:
    return {
        "version": 1,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "next_person_index": 1,
        "profiles": [],
    }


def new_profile(registry: dict[str, Any], embedding: np.ndarray) -> dict[str, Any]:
    idx = registry["next_person_index"]
    registry["next_person_index"] = idx + 1
    pid = f"anon-{idx:03d}"
    profile = {
        "id": pid,
        "display_name": f"Person {idx:03d}",
        "status": "anonymous",
        "identity_state": "anonymous",
        "canonical_name": None,
        "current_name": None,
        "current_name_confidence": 0.0,
        "first_seen_at": now_iso(),
        "last_seen_at": now_iso(),
        "embedding_count": 1,
        "embedding_centroid": embedding.tolist(),
        "name_candidates": {},
        "identity_events": [],
    }
    registry["profiles"].append(profile)
    return profile


def match_profile(
    registry: dict[str, Any],
    embedding: np.ndarray,
    threshold: float,
) -> tuple[dict[str, Any], float]:
    best_profile = None
    best_sim = -1.0
    for profile in registry["profiles"]:
        centroid = np.array(profile["embedding_centroid"], dtype=np.float32)
        sim = cosine_similarity(embedding, centroid)
        if sim > best_sim:
            best_sim = sim
            best_profile = profile

    if best_profile is None or best_sim < threshold:
        return new_profile(registry, embedding), best_sim
    return best_profile, best_sim


def update_centroid(profile: dict[str, Any], embedding: np.ndarray) -> None:
    count = int(profile["embedding_count"])
    centroid = np.array(profile["embedding_centroid"], dtype=np.float32)
    updated = (centroid * count + embedding) / float(count + 1)
    profile["embedding_centroid"] = updated.tolist()
    profile["embedding_count"] = count + 1
    profile["last_seen_at"] = now_iso()


def normalize_profile_shape(profile: dict[str, Any]) -> None:
    if "identity_state" not in profile:
        profile["identity_state"] = profile.get("status", "anonymous")
    profile.setdefault("current_name", profile.get("canonical_name"))
    profile.setdefault("current_name_confidence", 0.0)
    profile.setdefault("name_candidates", {})
    profile.setdefault("identity_events", [])


def sanitize_name(value: str) -> str | None:
    parts = [p for p in value.strip().split() if p]
    if not parts:
        return None
    cleaned = " ".join(parts[:3])
    if len(cleaned) < 2:
        return None
    return " ".join(p[:1].upper() + p[1:].lower() for p in cleaned.split())


def add_identity_evidence(
    profile: dict[str, Any],
    candidate_name: str,
    relation: str,
    confidence: float,
    similarity: float,
    rationale: str,
) -> None:
    normalize_profile_shape(profile)
    name = sanitize_name(candidate_name)
    if not name:
        return

    relation_weights = {
        "self": 1.0,
        "addressing": 0.9,
        "third_party": 0.35,
        "uncertain": 0.2,
    }
    rel_weight = relation_weights.get(relation, 0.2)
    c = min(1.0, max(0.0, float(confidence)))
    sim_weight = min(1.0, max(0.0, (similarity + 1.0) / 2.0))
    score_delta = rel_weight * c * (0.6 + 0.4 * sim_weight)

    candidates = profile["name_candidates"]
    info = candidates.get(name) or {
        "weighted_score": 0.0,
        "evidence_count": 0,
        "self_score": 0.0,
        "addressing_score": 0.0,
        "third_party_score": 0.0,
        "uncertain_score": 0.0,
        "last_seen_at": None,
    }
    info["weighted_score"] = float(info["weighted_score"]) + score_delta
    info["evidence_count"] = int(info["evidence_count"]) + 1
    key = f"{relation}_score" if f"{relation}_score" in info else "uncertain_score"
    info[key] = float(info[key]) + score_delta
    info["last_seen_at"] = now_iso()
    candidates[name] = info

    events = profile["identity_events"]
    events.append(
        {
            "at": now_iso(),
            "candidate_name": name,
            "relation": relation,
            "confidence": c,
            "similarity": similarity,
            "score_delta": score_delta,
            "rationale": rationale[:240],
        }
    )
    if len(events) > 200:
        del events[:-200]


def rank_candidates(profile: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    normalize_profile_shape(profile)
    return sorted(
        profile["name_candidates"].items(),
        key=lambda kv: float(kv[1]["weighted_score"]),
        reverse=True,
    )


def recompute_identity_state(
    profile: dict[str, Any],
    min_name_score: float,
    min_name_margin: float,
    min_name_confidence: float,
) -> None:
    normalize_profile_shape(profile)
    ranked = rank_candidates(profile)
    person_fallback = profile.get("display_name", "Person ???")
    if not ranked:
        profile["identity_state"] = "anonymous"
        profile["status"] = "anonymous"
        profile["current_name"] = None
        profile["canonical_name"] = None
        profile["current_name_confidence"] = 0.0
        if not person_fallback.startswith("Person "):
            profile["display_name"] = "Person ???"
        return

    top_name, top_info = ranked[0]
    top_score = float(top_info["weighted_score"])
    second_score = float(ranked[1][1]["weighted_score"]) if len(ranked) > 1 else 0.0
    total = sum(float(v["weighted_score"]) for _, v in ranked)
    ratio = (top_score / total) if total > 0 else 0.0
    margin = top_score - second_score
    confidence = min(1.0, 0.5 * ratio + 0.5 * min(1.0, top_score / (min_name_score + 1.0)))
    profile["current_name_confidence"] = confidence

    strong_direct = float(top_info.get("self_score", 0.0)) + float(top_info.get("addressing_score", 0.0))
    has_direct_basis = strong_direct >= 1.0

    current_name = profile.get("current_name")
    if current_name and current_name != top_name and top_score >= min_name_score and margin >= min_name_margin:
        profile["identity_state"] = "contested"
        profile["status"] = "contested"
        profile["display_name"] = f"{person_fallback} (?)"
        return

    if (
        top_score >= min_name_score
        and margin >= min_name_margin
        and confidence >= min_name_confidence
        and has_direct_basis
    ):
        profile["identity_state"] = "named"
        profile["status"] = "named"
        profile["current_name"] = top_name
        profile["canonical_name"] = top_name
        profile["display_name"] = top_name
        return

    profile["identity_state"] = "candidate_named"
    profile["status"] = "candidate_named"
    if str(person_fallback).startswith("Person "):
        profile["display_name"] = person_fallback
    else:
        profile["display_name"] = f"Person {profile['id'].replace('anon-', '')}"


def process_pair(
    wav_path: pathlib.Path,
    transcript_path: pathlib.Path,
    registry: dict[str, Any],
    encoder: VoiceEncoder,
    similarity_threshold: float,
    min_segment_s: float,
    identity_evidence: list[dict[str, Any]] | None,
    min_name_score: float,
    min_name_margin: float,
    min_name_confidence: float,
) -> list[dict[str, Any]]:
    audio = read_wav_mono_16k(wav_path)
    obj = json.loads(transcript_path.read_text(encoding="utf-8"))
    segments = parse_segments(obj)
    labeled_segments: list[dict[str, Any]] = []
    local_speaker_state: dict[str, dict[str, Any]] = {}

    for seg in segments:
        duration = seg.end - seg.start
        if duration < min_segment_s:
            continue
        clip = slice_audio(audio, seg.start, seg.end)
        if clip.size < int(min_segment_s * 16000):
            continue

        embedding = encoder.embed_utterance(clip.astype(np.float32))
        profile, similarity = match_profile(registry, embedding, similarity_threshold)
        normalize_profile_shape(profile)
        update_centroid(profile, embedding)
        local_speaker_state[seg.speaker] = {"profile": profile, "similarity": float(similarity)}

        labeled_segments.append(
            {
                "speaker_local": seg.speaker,
                "speaker_global_id": profile["id"],
                "speaker_display_name": profile["display_name"],
                "speaker_status": profile["identity_state"],
                "speaker_name_confidence": round(float(profile.get("current_name_confidence", 0.0)), 4),
                "match_similarity": round(similarity, 4),
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
            }
        )

    if identity_evidence:
        local_speakers = set(local_speaker_state.keys())
        for item in identity_evidence:
            if not isinstance(item, dict):
                continue
            source_local = str(item.get("source_speaker") or "").strip()
            target_local = item.get("target_speaker")
            target_local = str(target_local).strip() if isinstance(target_local, str) else ""
            relation = str(item.get("relation") or "uncertain").strip()
            candidate_name = str(item.get("candidate_name") or "").strip()
            rationale = str(item.get("rationale") or "").strip()
            try:
                conf = float(item.get("confidence") or 0.0)
            except Exception:
                conf = 0.0

            chosen_local = None
            if relation == "self" and source_local in local_speakers:
                chosen_local = source_local
            elif relation in ("addressing", "third_party", "uncertain"):
                if target_local and target_local in local_speakers:
                    chosen_local = target_local
                elif source_local in local_speakers and len(local_speakers) == 2 and relation == "addressing":
                    for spk in local_speakers:
                        if spk != source_local:
                            chosen_local = spk
                            break

            if not chosen_local:
                continue

            state = local_speaker_state[chosen_local]
            add_identity_evidence(
                state["profile"],
                candidate_name=candidate_name,
                relation=relation,
                confidence=conf,
                similarity=state["similarity"],
                rationale=rationale,
            )

    touched_ids = {row["speaker_global_id"] for row in labeled_segments}
    for profile in registry["profiles"]:
        normalize_profile_shape(profile)
        if profile["id"] in touched_ids:
            recompute_identity_state(
                profile,
                min_name_score=min_name_score,
                min_name_margin=min_name_margin,
                min_name_confidence=min_name_confidence,
            )

    for row in labeled_segments:
        profile = next((p for p in registry["profiles"] if p["id"] == row["speaker_global_id"]), None)
        if not profile:
            continue
        row["speaker_display_name"] = profile["display_name"]
        row["speaker_status"] = profile["identity_state"]
        row["speaker_name_confidence"] = round(float(profile.get("current_name_confidence", 0.0)), 4)

    registry["updated_at"] = now_iso()
    return labeled_segments


def main() -> int:
    parser = argparse.ArgumentParser(description="Learn persistent speaker identities from diarized chunks.")
    parser.add_argument("--chunks-dir", default="scripts/diarization-poc/out/chunks")
    parser.add_argument("--transcripts-dir", default="scripts/diarization-poc/out/transcripts")
    parser.add_argument("--out-dir", default="scripts/diarization-poc/out/labeled")
    parser.add_argument("--registry", default="scripts/diarization-poc/out/speaker_registry.json")
    parser.add_argument("--similarity-threshold", type=float, default=0.72)
    parser.add_argument("--min-segment-s", type=float, default=1.0)
    parser.add_argument("--identity-evidence-dir", default="scripts/diarization-poc/out/identity-evidence")
    parser.add_argument("--min-name-score", type=float, default=2.2)
    parser.add_argument("--min-name-margin", type=float, default=0.8)
    parser.add_argument("--min-name-confidence", type=float, default=0.72)
    args = parser.parse_args()

    chunks_dir = pathlib.Path(args.chunks_dir)
    transcripts_dir = pathlib.Path(args.transcripts_dir)
    out_dir = pathlib.Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    registry_path = pathlib.Path(args.registry)
    identity_evidence_dir = pathlib.Path(args.identity_evidence_dir)

    registry = load_json(registry_path, create_registry())
    encoder = VoiceEncoder()

    wavs = sorted(chunks_dir.glob("*.wav"))
    if not wavs:
        print("No chunk WAVs found.")
        return 1

    processed = 0
    for wav in wavs:
        transcript_segments = transcripts_dir / f"{wav.stem}.segments.json"
        transcript_raw = transcripts_dir / f"{wav.stem}.json"
        transcript = transcript_segments if transcript_segments.exists() else transcript_raw
        identity_evidence_path = identity_evidence_dir / f"{wav.stem}.identity.json"
        identity_obj = load_json(identity_evidence_path, {"evidence": []}) if identity_evidence_path.exists() else {"evidence": []}
        if not transcript.exists():
            continue
        try:
            labeled = process_pair(
                wav,
                transcript,
                registry=registry,
                encoder=encoder,
                similarity_threshold=args.similarity_threshold,
                min_segment_s=args.min_segment_s,
                identity_evidence=identity_obj.get("evidence"),
                min_name_score=args.min_name_score,
                min_name_margin=args.min_name_margin,
                min_name_confidence=args.min_name_confidence,
            )
        except Exception as exc:
            print(f"[learn] failed {wav.name}: {exc}")
            continue

        labeled_path = out_dir / f"{wav.stem}.labeled.json"
        write_json(
            labeled_path,
            {
                "source_wav": str(wav),
                "source_transcript": str(transcript),
                "segments": labeled,
            },
        )
        print(f"[learn] wrote {labeled_path}")
        processed += 1

    write_json(registry_path, registry)
    print(f"[learn] registry updated: {registry_path}")
    print(f"[learn] processed files: {processed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
