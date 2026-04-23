"""Enrichment Cloud Function.

Triggered by object.finalize on gs://sytycai-video-transcripts/.
Reads the raw transcript JSON, asks Claude to extract drama profiles,
and writes the enriched JSON to gs://sytycai-video-transcripts-enriched/.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
from typing import Any

import functions_framework
from anthropic import Anthropic
from cloudevents.http import CloudEvent
from google.cloud import storage

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── CONFIG ────────────────────────────────────────────────────────────────
RAW_BUCKET = os.environ.get("GCS_RAW_BUCKET", "sytycai-video-transcripts")
ENRICHED_BUCKET = os.environ.get(
    "GCS_ENRICHED_BUCKET", "sytycai-video-transcripts-enriched"
)
MODEL = "claude-sonnet-4-6"

# Warm across invocations — these clients are safe to reuse.
storage_client = storage.Client()
anthropic_client = Anthropic()

# ─── PROMPT ────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a drama analyst for Bravo TV. Your job is to read a Real Housewives reunion transcript and extract a structured drama profile for each Housewife who participates (ignore the host/moderator and audience).

For each Housewife, identify:

- drama_score: a 0-100 integer rating their overall drama intensity this reunion. Base this on how central they are to on-screen conflict, how much they escalate vs de-escalate, how many feuds reference them, and how emotionally charged their moments are. A 30 is a quiet season for them; a 90 is villain-of-the-season territory.
- feuds: their active feuds in format "Other Housewife: brief description of the conflict"
- key_moments: specific moments they were part of, cited from the transcript (brief quotes or scene descriptions)
- talking_points: 3-5 bullet points a Bravo producer would brief them with before going on stage
- confessional_draft: a short (2-3 sentence) dramatic talking-head script written in their voice, referencing their current drama arc

Work across any Housewives franchise (Salt Lake City, Beverly Hills, New Jersey, etc.). Be specific and cite transcript content where possible. Score objectively — don't inflate.

Use the show + season metadata provided in the user message to ground the cast: you likely already know who the Housewives are for that season, and who the recurring "Friends of" are. Use that prior knowledge to resolve ambiguous references ("she said...") and to catch transcription errors in names. If the transcript clearly references someone you don't expect for that season (a surprise guest, a crossover), include them too.

**CRITICAL — canonical names:** When a Cast list is provided in the user message, the `housewife_name` field in each profile MUST exactly match one of the full names from that list — no abbreviations, no nicknames, no misspellings, no first-name-only. For example, if the Cast list includes "Angie Katsanevas", do not output "Angie" or "Angie K." or "Angie Kastanevas". If no Cast list is provided, use the canonical full name you'd expect on-screen (first and last). Use this same canonical form everywhere her name appears (in feuds, key_moments, talking_points, etc.) for consistency.

Return your output via the save_drama_profiles tool."""


# ─── TOOL SCHEMA (structured output) ───────────────────────────────────────
DRAMA_PROFILE_TOOL = {
    "name": "save_drama_profiles",
    "description": "Save the structured drama profiles extracted from the transcript.",
    "input_schema": {
        "type": "object",
        "properties": {
            "franchise": {
                "type": "string",
                "description": "The Housewives franchise (e.g. 'Salt Lake City', 'Beverly Hills', 'New Jersey').",
            },
            "profiles": {
                "type": "array",
                "description": "One entry per Housewife appearing in the reunion.",
                "items": {
                    "type": "object",
                    "properties": {
                        "housewife_name": {"type": "string"},
                        "drama_score": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 100,
                        },
                        "feuds": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "key_moments": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "talking_points": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "confessional_draft": {"type": "string"},
                    },
                    "required": [
                        "housewife_name",
                        "drama_score",
                        "feuds",
                        "key_moments",
                        "talking_points",
                        "confessional_draft",
                    ],
                },
            },
        },
        "required": ["franchise", "profiles"],
    },
}


# ─── ENRICHMENT ────────────────────────────────────────────────────────────
def build_user_message(
    transcript_text: str,
    show: str | None,
    season: int | None,
    episode_title: str | None,
    cast: list[str] | None,
    notes: str | None,
    speaker_hints: list[str] | None,
) -> str:
    """Assemble the user-message body with all available grounding context."""
    lines = [f"Show: {show or 'Real Housewives'}"]
    if season:
        lines.append(f"Season: {season}")
    if episode_title:
        lines.append(f"Episode: {episode_title}")

    if cast:
        lines.append("")
        lines.append("Confirmed cast this reunion (use as attribution prior):")
        lines.extend(f"  - {name}" for name in cast)

    if notes:
        lines.append("")
        lines.append("Additional context from the producer:")
        lines.append(notes)

    if speaker_hints:
        lines.append("")
        lines.append("Speaker hints for ambiguous moments:")
        lines.extend(f"  - {hint}" for hint in speaker_hints)

    lines.append("")
    lines.append("Transcript:")
    lines.append("")
    lines.append(transcript_text)
    return "\n".join(lines)


def enrich_transcript(
    transcript_text: str,
    show: str | None,
    season: int | None,
    episode_title: str | None,
    cast: list[str] | None = None,
    notes: str | None = None,
    speaker_hints: list[str] | None = None,
) -> dict[str, Any]:
    """Call Claude and return the parsed drama-profile payload."""
    user_message = build_user_message(
        transcript_text=transcript_text,
        show=show,
        season=season,
        episode_title=episode_title,
        cast=cast,
        notes=notes,
        speaker_hints=speaker_hints,
    )

    response = anthropic_client.messages.create(
        model=MODEL,
        max_tokens=8192,
        # Cache the (constant) system prompt. Saves tokens/cost after the first
        # invocation in any 5-minute window.
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        tools=[DRAMA_PROFILE_TOOL],
        tool_choice={"type": "tool", "name": "save_drama_profiles"},
        messages=[{"role": "user", "content": user_message}],
    )

    for block in response.content:
        if block.type == "tool_use":
            return {
                "franchise": block.input.get("franchise"),
                "profiles": block.input.get("profiles", []),
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                    "cache_creation_input_tokens": getattr(
                        response.usage, "cache_creation_input_tokens", 0
                    ),
                    "cache_read_input_tokens": getattr(
                        response.usage, "cache_read_input_tokens", 0
                    ),
                },
            }

    raise RuntimeError("Claude did not return a tool_use block")


# ─── ENTRY POINT ───────────────────────────────────────────────────────────
@functions_framework.cloud_event
def on_transcript_finalized(cloud_event: CloudEvent) -> None:
    """GCS object.v1.finalized handler on the raw transcripts bucket."""
    data = cloud_event.data
    bucket_name = data["bucket"]
    file_name = data["name"]

    # Defensive: ignore anything that doesn't look like a raw transcript.
    if file_name.endswith("-enriched.json") or not file_name.endswith(".json"):
        logger.info("Skipping %s (not a raw transcript)", file_name)
        return

    logger.info("Enriching gs://%s/%s", bucket_name, file_name)

    raw_bucket = storage_client.bucket(bucket_name)
    raw_text = raw_bucket.blob(file_name).download_as_text()

    try:
        raw_data = json.loads(raw_text)
    except json.JSONDecodeError as err:
        logger.error("Invalid JSON in %s: %s", file_name, err)
        return

    transcript_text = raw_data.get("transcript", "")
    if not transcript_text:
        logger.warning("No transcript text in %s; skipping", file_name)
        return

    enrichment = enrich_transcript(
        transcript_text=transcript_text,
        show=raw_data.get("show"),
        season=raw_data.get("season"),
        episode_title=raw_data.get("episode_title"),
        cast=raw_data.get("cast"),
        notes=raw_data.get("notes"),
        speaker_hints=raw_data.get("speaker_hints"),
    )

    enriched = {
        "source": {
            "raw_bucket": bucket_name,
            "raw_file": file_name,
            "source_url": raw_data.get("source_url"),
            "video_id": raw_data.get("video_id"),
            "show": raw_data.get("show"),
            "season": raw_data.get("season"),
            "episode_title": raw_data.get("episode_title"),
        },
        "extracted_at": raw_data.get("extracted_at"),
        "enriched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "model": MODEL,
        "franchise": enrichment["franchise"],
        "profiles": enrichment["profiles"],
        "usage": enrichment["usage"],
    }

    enriched_file_name = file_name.replace(".json", "-enriched.json")
    enriched_blob = storage_client.bucket(ENRICHED_BUCKET).blob(enriched_file_name)
    enriched_blob.upload_from_string(
        json.dumps(enriched, indent=2),
        content_type="application/json",
    )

    logger.info(
        "Wrote gs://%s/%s — %d profiles, usage=%s",
        ENRICHED_BUCKET,
        enriched_file_name,
        len(enriched["profiles"]),
        enriched["usage"],
    )
