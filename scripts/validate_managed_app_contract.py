#!/usr/bin/env python3
"""Validate a managed application repository against the platform contract."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - optional dependency
    yaml = None


DNS_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
CONTRACT_VERSION = re.compile(r"^[0-9]+\.[0-9]+$")
SHA256_DIGEST = re.compile(r"@sha256:[0-9a-fA-F]{64}$")
IMAGE_LINE = re.compile(r"^\s*image:\s*['\"]?([^'\"\s#]+)", re.MULTILINE)
FORBIDDEN_DEPLOYMENT_TEXT = (
    "host.docker.internal",
    "live-code",
    "live code",
)
FORBIDDEN_PUBLISH_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r":latest\b"), "mutable :latest image tag"),
    (
        re.compile(r"for\s+\w+\s+in\s+[^\n;#]*\blatest\b"),
        "publish loop must not include latest",
    ),
    (
        re.compile(r"docker\s+tag\b[^\n;#]*\blatest\b", re.IGNORECASE),
        "docker tag to latest is forbidden",
    ),
    (
        re.compile(r"docker\s+push\b[^\n;#]*:latest\b", re.IGNORECASE),
        "docker push of :latest is forbidden",
    ),
)
PUBLISH_AUTOMATION_SUFFIXES = {".sh", ".groovy"}
ALLOWED_SECRET_DELIVERY = {"sops", "external-secrets", "out-of-band", "hybrid"}
ALLOWED_RELEASE_MODES = {"single", "blue-green", "single-and-blue-green"}
ALLOWED_APPLICATION_TIERS = {"internal", "external", "public", "critical"}
IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "target",
    "__pycache__",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".", type=Path)
    parser.add_argument("--app-config", default=".platform/application.yaml", type=Path)
    parser.add_argument("--chart-path", default="chart", type=Path)
    parser.add_argument("--allow-missing-chart", action="store_true")
    parser.add_argument("--allow-missing-dockerfiles", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    repo_root = args.repo_root.resolve()
    errors: list[str] = []
    warnings: list[str] = []

    config_path = resolve_under(repo_root, args.app_config)
    chart_path = resolve_under(repo_root, args.chart_path)

    config_data: dict[str, Any] | None = None
    if not config_path.exists():
        errors.append(f"{config_path}: missing managed application metadata")
    else:
        config_text = read_text(config_path)
        config_data = load_yaml_mapping(config_path, config_text, warnings)
        if config_data is None:
            validate_config_text(config_path, config_text, errors)
        else:
            validate_config_data(config_path, config_data, errors, warnings)

    if chart_path.exists():
        validate_chart(chart_path, config_data, errors, warnings)
    elif not args.allow_missing_chart:
        errors.append(f"{chart_path}: missing Helm chart path")

    dockerfiles = discover_dockerfiles(repo_root)
    if dockerfiles:
        for dockerfile in dockerfiles:
            validate_dockerfile(dockerfile, errors)
    elif not args.allow_missing_dockerfiles:
        errors.append(f"{repo_root}: no Dockerfile files found")

    validate_publish_automation(repo_root, errors)

    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1

    print("managed application contract validation passed")
    return 0


def resolve_under(repo_root: Path, path: Path) -> Path:
    if path.is_absolute():
        return path
    return repo_root / path


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def load_yaml_mapping(
    path: Path,
    text: str,
    warnings: list[str],
) -> dict[str, Any] | None:
    if yaml is None:
        warnings.append(
            f"{path}: PyYAML is unavailable; using fallback text validation for metadata"
        )
        return None
    loaded = yaml.safe_load(text)
    if not isinstance(loaded, dict):
        warnings.append(f"{path}: metadata did not parse as a YAML mapping")
        return None
    return loaded


def validate_config_data(
    path: Path,
    data: dict[str, Any],
    errors: list[str],
    warnings: list[str],
) -> None:
    contract_version = require_string(path, data, "contractVersion", errors)
    if contract_version and not CONTRACT_VERSION.match(contract_version):
        errors.append(f"{path}: contractVersion must look like 1.0")

    app_id = require_string(path, data, "application.id", errors)
    if app_id and not DNS_LABEL.match(app_id):
        errors.append(f"{path}: application.id must be a DNS-label style id")
    require_string(path, data, "application.name", errors)
    require_string(path, data, "application.owner", errors)

    tier = require_string(path, data, "application.tier", errors)
    if tier and tier not in ALLOWED_APPLICATION_TIERS:
        errors.append(
            f"{path}: application.tier must be one of {sorted(ALLOWED_APPLICATION_TIERS)}"
        )

    chart_name = require_string(path, data, "artifacts.chartName", errors)
    if chart_name and not DNS_LABEL.match(chart_name):
        errors.append(f"{path}: artifacts.chartName must be DNS-label style")

    images = get_path(data, "artifacts.images")
    if not isinstance(images, list) or not images:
        errors.append(f"{path}: artifacts.images must be a non-empty list")
    else:
        for index, image in enumerate(images):
            if not isinstance(image, dict):
                errors.append(f"{path}: artifacts.images[{index}] must be an object")
                continue
            for field in ("name", "dockerfile", "context"):
                if not image.get(field):
                    errors.append(f"{path}: artifacts.images[{index}].{field} is required")

    architectures = get_path(data, "artifacts.architectures")
    if not isinstance(architectures, list):
        errors.append(f"{path}: artifacts.architectures must list target platforms")
    else:
        for required_arch in ("linux/amd64", "linux/arm64"):
            if required_arch not in architectures:
                errors.append(f"{path}: artifacts.architectures must include {required_arch}")

    for field in (
        "runtime.health.liveness",
        "runtime.health.readiness",
        "runtime.health.metrics",
    ):
        value = require_string(path, data, field, errors)
        if value and not value.startswith("/"):
            errors.append(f"{path}: {field} must be an absolute HTTP path")

    if get_path(data, "configuration.environmentDriven") is not True:
        errors.append(f"{path}: configuration.environmentDriven must be true")
    if get_path(data, "secrets.referencesOnly") is not True:
        errors.append(f"{path}: secrets.referencesOnly must be true")

    secret_delivery = require_string(path, data, "secrets.secretDelivery", errors)
    if secret_delivery and secret_delivery not in ALLOWED_SECRET_DELIVERY:
        errors.append(
            f"{path}: secrets.secretDelivery must be one of {sorted(ALLOWED_SECRET_DELIVERY)}"
        )

    dependency_model = require_string(path, data, "dependencies.model", errors)
    if not dependency_model:
        errors.append(f"{path}: dependencies.model must describe ownership")

    release_mode = require_string(path, data, "delivery.releaseMode", errors)
    if release_mode and release_mode not in ALLOWED_RELEASE_MODES:
        errors.append(
            f"{path}: delivery.releaseMode must be one of {sorted(ALLOWED_RELEASE_MODES)}"
        )
    require_string(path, data, "delivery.promotion.source", errors)
    require_string(path, data, "delivery.promotion.stateRepo", errors)

    exceptions = data.get("exceptions", [])
    if exceptions is None:
        return
    if not isinstance(exceptions, list):
        errors.append(f"{path}: exceptions must be a list when present")
        return
    for index, exception in enumerate(exceptions):
        if not isinstance(exception, dict):
            errors.append(f"{path}: exceptions[{index}] must be an object")
            continue
        for field in ("requirement", "justification", "owner", "reviewDate"):
            if not exception.get(field):
                errors.append(f"{path}: exceptions[{index}].{field} is required")

    if yaml is None:
        warnings.append(f"{path}: install PyYAML in CI for full metadata validation")


def require_string(
    path: Path,
    data: dict[str, Any],
    dotted_path: str,
    errors: list[str],
) -> str | None:
    value = get_path(data, dotted_path)
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{path}: {dotted_path} is required")
        return None
    return value.strip()


def get_path(data: dict[str, Any], dotted_path: str) -> Any:
    current: Any = data
    for part in dotted_path.split("."):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def validate_config_text(path: Path, text: str, errors: list[str]) -> None:
    required_patterns = {
        "contractVersion": r"(?m)^contractVersion:\s*['\"]?[0-9]+\.[0-9]+['\"]?\s*$",
        "application.id": r"(?m)^\s*id:\s*[a-z0-9]([a-z0-9-]*[a-z0-9])?\s*$",
        "application.tier": r"(?m)^\s*tier:\s*(internal|external|public|critical)\s*$",
        "artifacts.chartName": r"(?m)^\s*chartName:\s*[a-z0-9]([a-z0-9-]*[a-z0-9])?\s*$",
        "runtime.health.liveness": r"(?m)^\s*liveness:\s*/",
        "runtime.health.readiness": r"(?m)^\s*readiness:\s*/",
        "runtime.health.metrics": r"(?m)^\s*metrics:\s*/",
        "secrets.secretDelivery": r"(?m)^\s*secretDelivery:\s*(sops|external-secrets|out-of-band|hybrid)\s*$",
        "delivery.releaseMode": r"(?m)^\s*releaseMode:\s*(single|blue-green|single-and-blue-green)\s*$",
    }
    for name, pattern in required_patterns.items():
        if re.search(pattern, text) is None:
            errors.append(f"{path}: missing or invalid {name}")
    for required_arch in ("linux/amd64", "linux/arm64"):
        if required_arch not in text:
            errors.append(f"{path}: metadata must include {required_arch}")


def validate_chart(
    chart_path: Path,
    config_data: dict[str, Any] | None,
    errors: list[str],
    warnings: list[str],
) -> None:
    chart_yaml = chart_path / "Chart.yaml"
    values_yaml = chart_path / "values.yaml"
    if not chart_yaml.exists():
        errors.append(f"{chart_yaml}: missing Helm Chart.yaml")
    if not values_yaml.exists():
        errors.append(f"{values_yaml}: missing Helm values.yaml")

    chart_files = [
        path
        for path in chart_path.rglob("*")
        if path.is_file() and path.suffix in {".yaml", ".yml", ".tpl"}
    ]
    chart_text = "\n".join(read_text(path) for path in chart_files)
    validate_forbidden_text(chart_path, chart_text, errors)
    validate_image_references(chart_path, chart_text, errors)

    required_tokens = (
        "livenessProbe",
        "readinessProbe",
        "resources:",
        "securityContext:",
        "runAsNonRoot",
        "readOnlyRootFilesystem",
    )
    for token in required_tokens:
        if token not in chart_text:
            errors.append(f"{chart_path}: chart must include {token}")

    release_mode = None
    if config_data is not None:
        release_mode = get_path(config_data, "delivery.releaseMode")
    if release_mode in {"blue-green", "single-and-blue-green"} and "releaseIntentLane" not in chart_text:
        errors.append(f"{chart_path}: blue/green capable charts must use releaseIntentLane")

    if "hostPath:" in chart_text:
        errors.append(f"{chart_path}: hostPath volumes are not portable")
    if re.search(r"(?m)^\s*hostNetwork:\s*true\s*$", chart_text):
        errors.append(f"{chart_path}: hostNetwork true is not allowed without an exception")

    if "dependencies:" not in chart_text:
        warnings.append(f"{chart_path}: chart values should document dependency references")
    if "secrets:" not in chart_text:
        warnings.append(f"{chart_path}: chart values should document Secret references")


def validate_publish_automation(repo_root: Path, errors: list[str]) -> None:
    paths: list[Path] = []
    jenkinsfile = repo_root / "Jenkinsfile"
    if jenkinsfile.is_file():
        paths.append(jenkinsfile)

    ci_dir = repo_root / "ci"
    if ci_dir.is_dir():
        for path in sorted(ci_dir.rglob("*")):
            if not path.is_file():
                continue
            if path.suffix in PUBLISH_AUTOMATION_SUFFIXES or path.name in {
                "Jenkinsfile",
                "publish",
                "build",
            }:
                paths.append(path)

    for path in paths:
        validate_publish_automation_text(path, read_text(path), errors)


def validate_publish_automation_text(path: Path, text: str, errors: list[str]) -> None:
    executable_text = strip_publish_automation_comments(text)
    for pattern, message in FORBIDDEN_PUBLISH_PATTERNS:
        if pattern.search(executable_text):
            errors.append(f"{path}: {message}")


def strip_publish_automation_comments(text: str) -> str:
    lines: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        if "#" in line:
            line = line.split("#", 1)[0]
        if "//" in line:
            line = re.split(r"\s//", line, maxsplit=1)[0]
        lines.append(line)
    return "\n".join(lines)


def validate_forbidden_text(path: Path, text: str, errors: list[str]) -> None:
    lowered = text.lower()
    for token in FORBIDDEN_DEPLOYMENT_TEXT:
        if token in lowered:
            errors.append(f"{path}: deployment contract forbids {token!r}")
    if re.search(r"(?m)^\s*(value:\s*)?localhost(:[0-9]+)?\s*$", lowered):
        errors.append(f"{path}: Kubernetes deployment values must not require localhost")


def validate_image_references(path: Path, text: str, errors: list[str]) -> None:
    for match in IMAGE_LINE.finditer(text):
        image = match.group(1)
        for error in validate_image_reference(image):
            errors.append(f"{path}: {error}: {image}")


def validate_image_reference(image: str) -> list[str]:
    errors: list[str] = []
    if uses_latest_tag(image):
        errors.append("mutable latest image tag is not allowed")
    if "@" in image and not uses_sha256_digest(image) and "{{" not in image:
        errors.append("image digest must use sha256:<64 hex chars>")
    if uses_sha256_digest(image) or "{{" in image:
        return errors
    if image_tag(image) is None:
        errors.append("image must use an explicit non-latest tag or sha256 digest")
    return errors


def uses_latest_tag(image: str) -> bool:
    return image_tag(image) == "latest"


def uses_sha256_digest(image: str) -> bool:
    return SHA256_DIGEST.search(image) is not None


def image_tag(image: str) -> str | None:
    name = image.split("@", 1)[0]
    last_segment = name.rsplit("/", 1)[-1]
    if ":" not in last_segment:
        return None
    return last_segment.rsplit(":", 1)[1]


def discover_dockerfiles(repo_root: Path) -> list[Path]:
    dockerfiles: list[Path] = []
    for path in repo_root.rglob("Dockerfile*"):
        if any(part in IGNORED_DIRS for part in path.parts):
            continue
        if path.is_file():
            dockerfiles.append(path)
    return sorted(dockerfiles)


def validate_dockerfile(path: Path, errors: list[str]) -> None:
    text = read_text(path)
    stages = re.split(r"(?im)^\s*FROM\s+", text)
    final_stage = stages[-1] if stages else text
    users = re.findall(r"(?im)^\s*USER\s+(.+?)\s*$", final_stage)
    if not users:
        errors.append(f"{path}: final image stage must set a non-root USER")
        return
    final_user = users[-1].strip().strip("'\"")
    if final_user in {"root", "0", "0:0"} or final_user.startswith("root:"):
        errors.append(f"{path}: final image stage must not run as root")


if __name__ == "__main__":
    raise SystemExit(main())
