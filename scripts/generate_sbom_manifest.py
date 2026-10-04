#!/usr/bin/env python3
"""Write a promotion-time SBOM manifest for scanned container images."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        metavar="NAME=IMAGE_REF",
        help="Repeat per image. Optional digest/sbom/trivy paths via env-style suffixes.",
    )
    parser.add_argument("--digest", action="append", default=[], metavar="NAME=DIGEST")
    parser.add_argument("--sbom", action="append", default=[], metavar="NAME=PATH")
    parser.add_argument("--trivy", action="append", default=[], metavar="NAME=PATH")
    return parser


def parse_pairs(values: list[str], label: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"{label} entries must look like name=value, got {value!r}")
        name, item_value = value.split("=", 1)
        name = name.strip()
        item_value = item_value.strip()
        if not name or not item_value:
            raise SystemExit(f"{label} entries must include non-empty name and value")
        parsed[name] = item_value
    return parsed


def main() -> int:
    args = build_parser().parse_args()
    digests = parse_pairs(args.digest, "--digest")
    sboms = parse_pairs(args.sbom, "--sbom")
    trivy_reports = parse_pairs(args.trivy, "--trivy")

    artifacts: list[dict[str, Any]] = []
    for artifact_arg in args.artifact:
        if "=" not in artifact_arg:
            raise SystemExit("--artifact entries must look like name=image-ref")
        name, image = artifact_arg.split("=", 1)
        name = name.strip()
        image = image.strip()
        if not name or not image:
            raise SystemExit("--artifact entries must include non-empty name and image ref")

        artifact: dict[str, Any] = {"name": name, "image": image}
        if name in digests:
            artifact["digest"] = digests[name]
        if name in sboms:
            artifact["sbomPath"] = sboms[name]
        if name in trivy_reports:
            artifact["trivyReportPath"] = trivy_reports[name]
        artifacts.append(artifact)

    if not artifacts:
        raise SystemExit("at least one --artifact entry is required")

    manifest = {
        "version": "1",
        "generatedAt": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "artifacts": artifacts,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
