"""One-shot backfill: generate csv/ siblings for every existing -enriched.json.

Run after deploying the updated main.py so pre-existing enriched files also land
as CSV for Data Cloud. Safe to rerun — csv/ blobs are overwritten in place.

Usage:
    python backfill_csv.py [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from google.cloud import storage

from main import render_csv

ENRICHED_BUCKET = os.environ.get(
    "GCS_ENRICHED_BUCKET", "sytycai-video-transcripts-enriched"
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    client = storage.Client()
    bucket = client.bucket(ENRICHED_BUCKET)

    # Only top-level -enriched.json files; skip anything already under csv/.
    blobs = [
        b
        for b in client.list_blobs(ENRICHED_BUCKET)
        if b.name.endswith("-enriched.json") and "/" not in b.name
    ]

    print(f"Found {len(blobs)} enriched JSON files in gs://{ENRICHED_BUCKET}/")

    for blob in blobs:
        base = blob.name.removesuffix("-enriched.json")
        csv_name = f"csv/{base}.csv"

        try:
            enriched = json.loads(blob.download_as_text())
        except json.JSONDecodeError as err:
            print(f"  SKIP {blob.name}: invalid JSON ({err})")
            continue

        csv_text = render_csv(enriched)
        row_count = len(enriched.get("profiles", []))

        if args.dry_run:
            print(f"  DRY {blob.name} -> {csv_name} ({row_count} rows)")
            continue

        bucket.blob(csv_name).upload_from_string(csv_text, content_type="text/csv")
        print(f"  OK  {blob.name} -> {csv_name} ({row_count} rows)")

    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
