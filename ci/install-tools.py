#!/usr/bin/env python3
"""Install checksum-pinned release tools; no remote install scripts or floating tags."""
import hashlib
import io
import os
from pathlib import Path
import platform
import tarfile
import urllib.request

# Pair order is amd64, arm64. Pins derive from the platform's proven tool versions.
TOOLS = [
    ('cosign', 'https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-{arch}',
     None, ('4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71', 'c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a')),
    ('docker', 'https://download.docker.com/linux/static/stable/{machine}/docker-28.0.4.tgz',
     'docker/docker', ('6b130fa5fb13516620d5ece0b63f63a495cede428bb2f9e24449022e9d72e0cb', 'd3291093e8ed576ed9e237b24dc4556a9ed21ff25d4c26578df612cb6fe0480f')),
    ('docker-buildx', 'https://github.com/docker/buildx/releases/download/v0.35.0/buildx-v0.35.0.linux-{arch}',
     None, ('d41ece72044243b4f58b343441ae37446d9c29a7d6b5e11c61847bbcf8f7dfda', 'c4248d6cbc4a619a7e0b4609c11e509ad4ac0b475e1c64817c0ac20c5d90c766')),
    ('helm', 'https://get.helm.sh/helm-v3.17.3-linux-{arch}.tar.gz',
     'linux-{arch}/helm', ('ee88b3c851ae6466a3de507f7be73fe94d54cbf2987cbaa3d1a3832ea331f2cd', '7944e3defd386c76fd92d9e6fec5c2d65a323f6fadc19bfb5e704e3eee10348e')),
    ('gitleaks', 'https://github.com/gitleaks/gitleaks/releases/download/v8.24.2/gitleaks_8.24.2_linux_{gitleaks_arch}.tar.gz',
     'gitleaks', ('fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e', '574a6d52573c61173add7ddb5e3cc68c0e82cb0735818a1eeb9a0a2de1643fbc')),
    ('trivy', 'https://github.com/aquasecurity/trivy/releases/download/v0.71.0/trivy_0.71.0_Linux-{trivy_arch}.tar.gz',
     'trivy', ('30a3d22b23f88c233f1658f562fb477cae3b3e8b4761109d515b7698daf85814', '2561be394a3199c911f82fced606cbc05e1cb23eb6ce1da6935540adb76f4252')),
    ('syft', 'https://github.com/anchore/syft/releases/download/v1.18.1/syft_1.18.1_linux_{arch}.tar.gz',
     'syft', ('066c251652221e4d44fcc4d115ce3df33a91769da38c830a8533199db2f65aab', 'cd228306e5cb0654baecb454f76611606b84899d27fa9ceb7da4df46b94fe84e')),
]


def main():
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]
    values = dict(arch=arch, machine='x86_64' if arch == 'amd64' else 'aarch64',
                  gitleaks_arch='x64' if arch == 'amd64' else 'arm64',
                  trivy_arch='64bit' if arch == 'amd64' else 'ARM64')
    target = Path('/opt/war-table-ci/bin')
    target.mkdir(parents=True, exist_ok=True)
    for name, url, member, hashes in TOOLS:
        with urllib.request.urlopen(url.format(**values), timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != hashes[arch == 'arm64']:
            raise SystemExit(f'Integrity check failed: {name}')
        if member:
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                data = archive.extractfile(member.format(**values)).read()
        (target / name).write_bytes(data)
        (target / name).chmod(0o755)
    plugins = Path.home() / '.docker/cli-plugins'
    plugins.mkdir(parents=True, exist_ok=True)
    (plugins / 'docker-buildx').unlink(missing_ok=True)
    (plugins / 'docker-buildx').symlink_to(target / 'docker-buildx')


if __name__ == '__main__':
    main()
