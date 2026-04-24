"""Enrichment Cloud Function.

Triggered by object.finalize on gs://sytycai-video-transcripts/.
Reads the raw transcript JSON, asks Claude to extract drama profiles,
and writes the enriched JSON to gs://sytycai-video-transcripts-enriched/.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
import os
import re
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
                        "gender": {
                            "type": "string",
                            "enum": ["female", "male"],
                            "description": "Gender of the cast member. Most are female; use 'male' for husbands, Andys, or male recurring cast.",
                        },
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


# ─── CSV OUTPUT ────────────────────────────────────────────────────────────
CSV_COLUMNS = [
    "profile_id",
    "housewife_name",
    "sf_id",
    "drama_score",
    "feuds",
    "key_moments",
    "talking_points",
    "confessional_draft",
    "show",
    "season",
    "franchise",
    "episode_title",
    "source_url",
    "video_id",
    "raw_file",
    "enriched_at",
]

# Maps canonical housewife_name -> Salesforce Contact Id. Used as the match key
# for Data Cloud identity resolution back onto Contact records.
SF_ID_MAP = {
    "Amanda Frances": "003Hs00007ZzLJrIAN",
    "Angie Katsanevas": "003Hs00007ZzLJwIAN",
    "Angie Kukk": "003Hs00007ZzLK1IAN",
    "Bozoma St. John": "003Hs00007ZzLK6IAN",
    "Britani Bateman": "003Hs00007ZzLKBIA3",
    "Bronwyn Newport": "003Hs00007ZzLKGIA3",
    "Camille Grammer": "003Hs00007ZzLKLIA3",
    "Crystal Kung Minkoff": "003Hs00007ZzLKQIA3",
    "Danielle Cabral": "003Hs00007ZzLKVIA3",
    "Denise Richards": "003Hs00007ZzLKaIAN",
    "Dolores Catania": "003Hs00007ZzLKfIAN",
    "Dorit Kemsley": "003Hs00007ZzKsVIAV",
    "Erika Jayne Girardi": "003Hs00007ZzLKkIAN",
    "Garcelle Beauvais": "003Hs00007ZzKsQIAV",
    "Heather Gay": "003Hs00007ZzLKpIAN",
    "Jackie Goldschneider": "003Hs00007ZzLKuIAN",
    "Jen Shah": "003Hs00007ZzLKzIAN",
    "Jennifer Aydin": "003Hs00007ZzLL4IAN",
    "Jennifer Fessler": "003Hs00007ZzLJsIAN",
    "Jennifer Tilly": "003Hs00007ZzLL9IAN",
    "Joe Gorga": "003Hs00007ZzLLEIA3",
    "Kathy Hilton": "003Hs00007ZzKsgIAF",
    "Kyle Richards": "003Hs00007ZzKskIAF",
    "Lisa Barlow": "003Hs00007ZzLLJIA3",
    "Lisa Rinna": "003Hs00007ZzLLOIA3",
    "Lisa Vanderpump": "003Hs00007ZzLLTIA3",
    "Louie Ruelas": "003Hs00007ZzLLYIA3",
    "Margaret Josephs": "003Hs00007ZzLLdIAN",
    "Mary Cosby": "003Hs00007ZzLLiIAN",
    "Melissa Gorga": "003Hs00007ZzLLnIAN",
    "Meredith Marks": "003Hs00007ZzLLsIAN",
    "Monica Garcia": "003Hs00007ZzLLxIAN",
    "Natalie Swanston Fuller": "003Hs00007ZzLM2IAN",
    "Rachel Fuda": "003Hs00007ZzLM7IAN",
    "Rachel Zoe": "003Hs00007ZzLMCIA3",
    "Sutton Stracke": "003Hs00007ZzKsfIAF",
    "Teddi Mellencamp Arroyave": "003Hs00007ZzLMHIA3",
    "Teresa Giudice": "003Hs00007ZzLLtIAN",
    "Whitney Rose": "003Hs00007ZzLMMIA3",
}

# Transcript-name variants that should resolve to a canonical SF_ID_MAP key.
# Extend as you discover new misspellings / nicknames in enriched output.
SF_NAME_ALIASES = {
    "Erika Girardi": "Erika Jayne Girardi",
    "Erika Jayne": "Erika Jayne Girardi",
    "Mary Crosby": "Mary Cosby",
}


def lookup_sf_id(housewife_name: str) -> str:
    """Resolve a housewife name (with alias fallback) to a Salesforce Contact Id."""
    canonical = SF_NAME_ALIASES.get(housewife_name, housewife_name)
    return SF_ID_MAP.get(canonical, "")


def _slug(value: Any) -> str:
    """Lowercase, alphanumeric-only slug for building profile_id."""
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")


def build_profile_id(
    housewife_name: str,
    show: str | None,
    season: int | None,
    episode_title: str | None,
) -> str:
    return "__".join(
        [
            _slug(housewife_name),
            _slug(show),
            f"s{season}" if season is not None else "s",
            _slug(episode_title),
        ]
    )


def render_csv(enriched: dict[str, Any]) -> str:
    """Flatten enriched payload into one CSV row per housewife profile."""
    source = enriched.get("source", {}) or {}
    show = source.get("show")
    season = source.get("season")
    episode_title = source.get("episode_title")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, quoting=csv.QUOTE_ALL)
    writer.writeheader()
    for profile in enriched.get("profiles", []):
        housewife_name = profile.get("housewife_name", "")
        writer.writerow(
            {
                "profile_id": build_profile_id(
                    housewife_name,
                    show,
                    season,
                    episode_title,
                ),
                "housewife_name": housewife_name,
                "sf_id": lookup_sf_id(housewife_name),
                "drama_score": profile.get("drama_score", ""),
                "feuds": "\n".join(profile.get("feuds", []) or []),
                "key_moments": "\n".join(profile.get("key_moments", []) or []),
                "talking_points": "\n".join(profile.get("talking_points", []) or []),
                "confessional_draft": profile.get("confessional_draft", ""),
                "show": show or "",
                "season": season if season is not None else "",
                "franchise": enriched.get("franchise", ""),
                "episode_title": episode_title or "",
                "source_url": source.get("source_url", "") or "",
                "video_id": source.get("video_id", "") or "",
                "raw_file": source.get("raw_file", "") or "",
                "enriched_at": enriched.get("enriched_at", ""),
            }
        )
    return buf.getvalue()


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

    enriched_bucket = storage_client.bucket(ENRICHED_BUCKET)

    enriched_file_name = file_name.replace(".json", "-enriched.json")
    enriched_bucket.blob(enriched_file_name).upload_from_string(
        json.dumps(enriched, indent=2),
        content_type="application/json",
    )

    csv_file_name = f"csv/{file_name.replace('.json', '.csv')}"
    enriched_bucket.blob(csv_file_name).upload_from_string(
        render_csv(enriched),
        content_type="text/csv",
    )

    logger.info(
        "Wrote gs://%s/%s and gs://%s/%s — %d profiles, usage=%s",
        ENRICHED_BUCKET,
        enriched_file_name,
        ENRICHED_BUCKET,
        csv_file_name,
        len(enriched["profiles"]),
        enriched["usage"],
    )
