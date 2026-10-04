#!/usr/bin/env python3
"""Validate SBOM artifacts exist before opening a platform-state promotion PR."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

SHA256_DIGEST = re.compile(r"^sha256:[0-9a-fA-F]{64}$")
MIN_SBOM_BYTES = 64


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument(
        "--repo-root",
        default=".",
        type=Path,
        help="Resolve sbomPath and trivyReportPath relative to this directory",
    )
    parser.add_argument(
        "--require-digest",
        action="store_true",
        help="Fail when an artifact is missing a sha256 digest",
    )
    return parser


def validate_manifest(data: dict[str, Any], repo_root: Path, require_digest: bool) -> list[str]:
    errors: list[str] = []
    version = data.get("version")
    if version != "1":
        errors.append("manifest version must be 1")

    artifacts = data.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("manifest must include a non-empty artifacts list")
        return errors

    for index, artifact in enumerate(artifacts):
        prefix = f"artifacts[{index}]"
        if not isinstance(artifact, dict):
            errors.append(f"{prefix} must be an object")
            continue

        name = artifact.get("name")
        image = artifact.get("image")
        sbom_path = artifact.get("sbomPath")
        digest = artifact.get("digest")

        if not isinstance(name, str) or not name.strip():
            errors.append(f"{prefix}.name is required")
        if not isinstance(image, str) or not image.strip():
            errors.append(f"{prefix}.image is required")
        if not isinstance(sbom_path, str) or not sbom_path.strip():
            errors.append(f"{prefix}.sbomPath is required")
            continue

        resolved_sbom = (repo_root / sbom_path).resolve()
        if not resolved_sbom.is_file():
            errors.append(f"{prefix}.sbomPath does not exist: {resolved_sbom}")
        elif resolved_sbom.stat().st_size < MIN_SBOM_BYTES:
            errors.append(f"{prefix}.sbomPath is too small to be a valid SBOM: {resolved_sbom}")
        else:
            try:
                payload = json.loads(resolved_sbom.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                errors.append(f"{prefix}.sbomPath is not valid JSON: {resolved_sbom}")
            else:
                if not isinstance(payload, dict):
                    errors.append(f"{prefix}.sbomPath must contain a JSON object")

        trivy_path = artifact.get("trivyReportPath")
        if trivy_path is not None:
            if not isinstance(trivy_path, str) or not trivy_path.strip():
                errors.append(f"{prefix}.trivyReportPath must be a non-empty string when present")
            else:
                resolved_trivy = (repo_root / trivy_path).resolve()
                if not resolved_trivy.is_file():
                    errors.append(f"{prefix}.trivyReportPath does not exist: {resolved_trivy}")

        if require_digest:
            if not isinstance(digest, str) or not SHA256_DIGEST.match(digest):
                errors.append(f"{prefix}.digest must match sha256:<64 hex chars>")

    return errors


def main() -> int:
    args = build_parser().parse_args()
    repo_root = args.repo_root.resolve()

    if not args.manifest.is_file():
        print(f"error: manifest not found: {args.manifest}", flush=True)
        return 1

    try:
        data = json.loads(args.manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"error: manifest is not valid JSON: {exc}", flush=True)
        return 1

    if not isinstance(data, dict):
        print("error: manifest must be a JSON object", flush=True)
        return 1

    errors = validate_manifest(data, repo_root, args.require_digest)
    if errors:
        for error in errors:
            print(f"error: {error}", flush=True)
        return 1

    print("sbom manifest validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
