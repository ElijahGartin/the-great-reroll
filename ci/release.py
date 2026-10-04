#!/usr/bin/env python3
"""Publish verified OCI artifacts. Environment configuration belongs to platform-state."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import shutil
import tarfile
import urllib.error
import urllib.request

SOURCE = 'https://github.com/ElijahGartin/the-great-reroll'
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
MEDIA = 'application/vnd.oci.image.index.v1+json'
ACCEPT = ', '.join([MEDIA, 'application/vnd.docker.distribution.manifest.list.v2+json',
                    'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])


def run(*args, capture=False, env=None):
    return subprocess.run(args, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, env=env).stdout


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2) + '\n')


def unpack_chart(source, destination):
    # Debian's Python 3.11.2 predates tarfile's extraction filters. Chart SBOM
    # input accepts regular files/directories only and never follows links.
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(source) as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError('Unsafe chart archive member')
            target = destination.joinpath(*path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as data, target.open('xb') as output:
                    shutil.copyfileobj(data, output)


class Registry:
    def __init__(self):
        self.host = os.environ['REGISTRY']
        if not re.fullmatch(r'[a-zA-Z0-9.-]+(?::[0-9]+)?', self.host):
            raise ValueError('REGISTRY must be a hostname with optional port')
        if os.environ['CI_REGISTRY'] != self.host:
            raise ValueError('REGISTRY and CI_REGISTRY must match')
        self.http = os.environ.get('CI_REGISTRY_INSECURE') == 'true'
        self.base = ('http' if self.http else 'https') + '://' + self.host

    def manifest(self, repo, ref, data=None):
        headers = {'Accept': ACCEPT}
        if data is not None:
            headers['Content-Type'] = MEDIA
        request = urllib.request.Request(f'{self.base}/v2/{repo}/manifests/{ref}', data=data,
                                         headers=headers, method='PUT' if data is not None else 'GET')
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read()
            if data is not None:
                expected = 'sha256:' + hashlib.sha256(data).hexdigest()
                published = self.manifest(repo, ref)
                if published[0] != expected:
                    raise ValueError('Published manifest differs from submitted bytes')
                return published
            digest = 'sha256:' + hashlib.sha256(body).hexdigest()
            if response.headers.get('Docker-Content-Digest', digest) != digest:
                raise ValueError('Registry digest does not match manifest bytes')
            if ref.startswith('sha256:') and ref != digest:
                raise ValueError('Registry returned a different digest')
            return digest, body, response.headers['Content-Type'].split(';')[0]

    def require_absent(self, repo, ref):
        try:
            self.manifest(repo, ref)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return
            raise
        raise ValueError(f'Refusing to overwrite existing tag {repo}:{ref}')


def architecture_manifest(body, arch):
    doc = json.loads(body)
    if 'manifests' in doc:
        matches = [m for m in doc['manifests'] if m.get('platform', {}).get('os') == 'linux'
                   and m.get('platform', {}).get('architecture') == arch]
        if len(matches) != 1 or not DIGEST.fullmatch(matches[0]['digest']):
            raise ValueError(f'Expected exactly one linux/{arch} manifest')
        return matches[0]['digest']
    raise ValueError('Build must emit a platform index for architecture verification')


def verify_chart_content(body, package):
    content = Path(package).read_bytes()
    layers = json.loads(body).get('layers', [])
    if len(layers) != 1 or layers[0].get('mediaType') != 'application/vnd.cncf.helm.chart.content.v1.tar+gzip':
        raise ValueError('Chart must contain exactly its packaged content layer')
    if layers[0].get('digest') != 'sha256:' + hashlib.sha256(content).hexdigest() or layers[0].get('size') != len(content):
        raise ValueError('Published chart does not match the locally packaged source')


def provenance(sha, invocation):
    return {
        'buildDefinition': {
            'buildType': SOURCE + '/ci/jenkins/v1',
            'externalParameters': {'source': SOURCE, 'revision': sha},
            'internalParameters': {},
            'resolvedDependencies': [{'uri': 'git+' + SOURCE, 'digest': {'gitCommit': sha}}],
        },
        'runDetails': {'builder': {'id': SOURCE + '/Jenkinsfile'},
                       'metadata': {'invocationId': invocation}},
    }


def verify_statements(output, ref, kind, expected):
    # cosign versions may emit one envelope per line or a JSON envelope array.
    decoder = json.JSONDecoder()
    envelopes = []
    while output.strip():
        value, end = decoder.raw_decode(output.lstrip())
        output = output.lstrip()[end:]
        envelopes.extend(value if isinstance(value, list) else [value])
    predicates = []
    for envelope in envelopes:
        statement = json.loads(base64.b64decode(envelope['payload'], validate=True))
        subjects = statement.get('subject', [])
        digest = ref.rsplit('@sha256:', 1)[1]
        if not any(subject.get('digest', {}).get('sha256') == digest for subject in subjects):
            raise ValueError('Attestation subject does not match released digest')
        if statement.get('predicateType') != kind:
            raise ValueError('Unexpected attestation predicate type')
        predicates.append(statement.get('predicate'))
    if not all(item in predicates for item in expected):
        raise ValueError('Verified attestations do not contain this build evidence')


def sign_and_verify(ref, sbom_paths, predicate, registry, signing_env):
    transport = ['--allow-http-registry'] if registry.http else []
    common = ['--yes', '--key', '/signing/cosign.key', '--use-signing-config=false', '--tlog-upload=false', *transport]
    run('cosign', 'sign', *common, ref, env=signing_env)
    run('cosign', 'attest', *common, '--type', 'https://slsa.dev/provenance/v1', '--predicate', predicate, ref, env=signing_env)
    for path in sbom_paths:
        run('cosign', 'attest', *common, '--type', 'spdxjson', '--predicate', path, ref, env=signing_env)
    verify = ['--key', 'ci/cosign.pub', '--insecure-ignore-tlog', *transport]
    run('cosign', 'verify', *verify, ref)
    for kind, paths in [('https://slsa.dev/provenance/v1', [predicate]), ('https://spdx.dev/Document', sbom_paths)]:
        output = run('cosign', 'verify-attestation', *verify, '--type', kind, ref, capture=True)
        verify_statements(output, ref, kind, [json.loads(Path(path).read_text()) for path in paths])


def main():
    # Run even when invoked independently of the Jenkinsfile.
    Path('dist/release.json').unlink(missing_ok=True)
    run('bash', 'ci/trusted-main.sh')
    sha = run('git', 'rev-parse', 'HEAD', capture=True).strip()
    build = os.environ['BUILD_NUMBER']
    tag = f'{sha}-{build}-quarantine'
    version = f'1.0.0-ci.{build}.g{sha[:12]}'
    registry = Registry()
    repo = 'platform/war-table'
    image = registry.host + '/' + repo
    chart_repo = 'platform/charts/war-table'
    registry.require_absent(repo, tag)
    registry.require_absent(chart_repo, version)
    signing_env = dict(os.environ, COSIGN_PASSWORD=Path('/signing/password').read_text().rstrip('\n'))
    if Path('/signing/cosign.pub').read_bytes() != Path('ci/cosign.pub').read_bytes():
        raise ValueError('Mounted signing key does not match the reviewed application trust key')
    for key in ('/signing/cosign.key', '/signing/cosign.pub', '/certs/ca.crt', '/certs/tls.crt', '/certs/tls.key'):
        if not Path(key).is_file():
            raise ValueError(f'Missing delivery prerequisite: {key}')
    manifests = []
    for arch in ('amd64', 'arm64'):
        arch_tag = tag + '-' + arch
        registry.require_absent(repo, arch_tag)
        tls = 'cacert=/certs/ca.crt,cert=/certs/tls.crt,key=/certs/tls.key,servername=' + os.environ[f'BUILDKIT_{arch.upper()}_NAME']
        builder = 'war-table-' + arch
        run('docker', 'buildx', 'create', '--name', builder, '--driver', 'remote', '--platform', 'linux/' + arch,
            '--driver-opt', tls, os.environ[f'BUILDKIT_{arch.upper()}_ADDR'])
        output = 'type=registry,push=true' + (',registry.insecure=true' if registry.http else '')
        metadata = f'dist/build-{arch}.json'
        Path('dist').mkdir(exist_ok=True)
        run('docker', 'buildx', 'build', '--builder', builder, '--platform', 'linux/' + arch,
            '--provenance=mode=max', '--metadata-file', metadata, '--tag', image + ':' + arch_tag, '--output', output, '.')
        built_digest = json.loads(Path(metadata).read_text())['containerimage.digest']
        if not DIGEST.fullmatch(built_digest):
            raise ValueError('BuildKit did not report an immutable artifact digest')
        _, body, _ = registry.manifest(repo, built_digest)
        digest = architecture_manifest(body, arch)
        digest, body, content_type = registry.manifest(repo, digest)
        manifests.append({'mediaType': content_type, 'digest': digest, 'size': len(body),
                          'platform': {'os': 'linux', 'architecture': arch}})
    index = json.dumps({'schemaVersion': 2, 'mediaType': MEDIA, 'manifests': manifests}, separators=(',', ':')).encode()
    image_digest, _, _ = registry.manifest(repo, tag, index)
    artifacts = []
    image_sboms = []
    scan_env = dict(os.environ, SYFT_REGISTRY_INSECURE_USE_HTTP=str(registry.http).lower(),
                    TRIVY_INSECURE=str(registry.http).lower())
    Path('dist/security/reports').mkdir(parents=True, exist_ok=True)
    Path('dist/security/sboms').mkdir(parents=True, exist_ok=True)
    for descriptor in manifests:
        arch = descriptor['platform']['architecture']
        ref = image + '@' + descriptor['digest']
        sbom = f'dist/security/sboms/app-{arch}.spdx.json'
        report = f'dist/security/reports/app-{arch}-trivy.json'
        run('trivy', 'image', '--image-src', 'remote', '--platform', 'linux/' + arch,
            '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--exit-code', '1',
            '--format', 'json', '--output', report, ref, env=scan_env)
        run('syft', 'registry:' + ref, '--platform', 'linux/' + arch, '-o', 'spdx-json=' + sbom, env=scan_env)
        artifacts.append({'name': 'app-' + arch, 'image': ref, 'digest': descriptor['digest'],
                          'sbomPath': sbom, 'trivyReportPath': report})
        image_sboms.append(sbom)
    run('helm', 'package', 'deploy/helm/war-table', '--version', version, '--app-version', sha,
        '--destination', 'dist/charts')
    # Scan the exact packaged chart contents, not the mutable source tree.
    unpack_chart(f'dist/charts/war-table-{version}.tgz', 'dist/chart-source')
    chart_sbom = 'dist/security/sboms/chart.spdx.json'
    run('syft', 'dir:dist/chart-source', '-o', 'spdx-json=' + chart_sbom)
    run('helm', 'push', f'dist/charts/war-table-{version}.tgz', 'oci://' + registry.host + '/platform/charts',
        *(['--plain-http'] if registry.http else []))
    chart_digest, chart_body, _ = registry.manifest(chart_repo, version)
    verify_chart_content(chart_body, f'dist/charts/war-table-{version}.tgz')
    chart_ref = registry.host + '/' + chart_repo + '@' + chart_digest
    artifacts.append({'name': 'chart', 'image': chart_ref, 'digest': chart_digest, 'sbomPath': chart_sbom})
    manifest = {'version': '1', 'generatedAt': datetime.now(timezone.utc).isoformat(),
                'sourceSHA': sha, 'imageIndexDigest': image_digest, 'artifacts': artifacts}
    write('dist/security/sbom-manifest.json', manifest)
    run('python3', 'scripts/validate_sbom_manifest.py', '--manifest', 'dist/security/sbom-manifest.json',
        '--repo-root', '.', '--require-digest')
    predicate = 'dist/security/provenance.json'
    write(predicate, provenance(sha, os.environ.get('BUILD_TAG', 'war-table-' + build)))
    sign_and_verify(image + '@' + image_digest, image_sboms, predicate, registry, signing_env)
    sign_and_verify(chart_ref, [chart_sbom], predicate, registry, signing_env)
    # This file is intentionally the last operation and the only promotion input.
    write('dist/release.json', {'application': 'war-table', 'chartVersion': version,
          'imageDigest': image_digest, 'chartDigest': chart_digest, 'sourceSHA': sha,
          'sbomManifestSHA256': hashlib.sha256(Path('dist/security/sbom-manifest.json').read_bytes()).hexdigest()})


if __name__ == '__main__':
    main()
