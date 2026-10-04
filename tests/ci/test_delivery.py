import base64
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('delivery', ROOT / 'ci/release.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryTests(unittest.TestCase):
    def test_chart_digest_and_size_must_match_local_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            package = Path(tmp) / 'chart.tgz'
            package.write_bytes(b'packaged chart')
            layer = {'mediaType': 'application/vnd.cncf.helm.chart.content.v1.tar+gzip',
                     'digest': 'sha256:' + hashlib.sha256(package.read_bytes()).hexdigest(),
                     'size': package.stat().st_size}
            delivery.verify_chart_content(json.dumps({'layers': [layer]}), package)
            for layers in ([], [layer, layer], [{**layer, 'digest': 'sha256:' + '0' * 64}],
                           [{**layer, 'size': 0}]):
                with self.assertRaises(ValueError):
                    delivery.verify_chart_content(json.dumps({'layers': layers}), package)

    def test_chart_unpack_rejects_traversal_and_links(self):
        for name, kind in [('war-table/Chart.yaml', tarfile.REGTYPE),
                           ('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                           ('war-table/link', tarfile.SYMTYPE), ('war-table/link', tarfile.LNKTYPE)]:
            with tempfile.TemporaryDirectory() as tmp:
                source = Path(tmp) / 'chart.tgz'
                with tarfile.open(source, 'w:gz') as archive:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.size = 2 if kind == tarfile.REGTYPE else 0
                    member.linkname = '/outside' if kind != tarfile.REGTYPE else ''
                    archive.addfile(member, io.BytesIO(b'{}') if member.size else None)
                destination = Path(tmp) / 'contents'
                if name == 'war-table/Chart.yaml':
                    delivery.unpack_chart(source, destination)
                    self.assertEqual((destination / name).read_bytes(), b'{}')
                else:
                    with self.assertRaises(ValueError):
                        delivery.unpack_chart(source, destination)

    def test_publication_rejects_pr_and_non_main_before_git(self):
        for updates in ({'CHANGE_ID': '12', 'GIT_BRANCH': 'origin/main'}, {'BRANCH_NAME': 'feature'}, {}):
            env = {'PATH': os.environ['PATH'], **updates}
            result = subprocess.run(['bash', str(ROOT / 'ci/trusted-main.sh')], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_publication_requires_exact_main_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            git = Path(tmp) / 'git'
            git.write_text('#!/bin/sh\ncase "$1" in config) exit 0;; rev-parse) echo abc;; ls-remote) printf "abc\\trefs/heads/main\\n";; status) exit 0;; esac\n')
            git.chmod(0o755)
            env = {'PATH': tmp + ':' + os.environ['PATH'], 'GIT_BRANCH': 'origin/main', 'GIT_COMMIT': 'abc', 'BUILD_NUMBER': '1'}
            result = subprocess.run(['bash', str(ROOT / 'ci/trusted-main.sh')], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            for key, value in [('GIT_COMMIT', 'wrong'), ('BUILD_NUMBER', '../bad')]:
                result = subprocess.run(['bash', str(ROOT / 'ci/trusted-main.sh')], env={**env, key: value}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)

    def test_architecture_selection_excludes_buildkit_attestations(self):
        digest = 'sha256:' + 'a' * 64
        body = json.dumps({'manifests': [
            {'digest': digest, 'platform': {'os': 'linux', 'architecture': 'amd64'}},
            {'digest': 'sha256:' + 'b' * 64, 'platform': {'os': 'unknown', 'architecture': 'unknown'}}]})
        self.assertEqual(delivery.architecture_manifest(body, 'amd64'), digest)
        with self.assertRaises(ValueError):
            delivery.architecture_manifest(body, 'arm64')

    def test_verified_attestation_must_match_subject_and_predicate(self):
        kind = 'https://slsa.dev/provenance/v1'
        predicate = delivery.provenance('abc', 'build-1')
        statement = {'subject': [{'digest': {'sha256': 'a' * 64}}], 'predicateType': kind, 'predicate': predicate}
        def output():
            return json.dumps({'payload': base64.b64encode(json.dumps(statement).encode()).decode()})
        ref = 'registry.example/app@sha256:' + 'a' * 64
        delivery.verify_statements(output(), ref, kind, [predicate])
        with self.assertRaises(ValueError):
            delivery.verify_statements(output(), ref, kind, [{'different': True}])
        with self.assertRaises(ValueError):
            delivery.verify_statements(output(), ref.replace('a' * 64, 'b' * 64), kind, [predicate])
        with self.assertRaises(ValueError):
            delivery.verify_statements('', ref, kind, [predicate])

    def test_release_manifest_not_written_on_failed_signature_verification(self):
        with patch.object(delivery, 'run', side_effect=subprocess.CalledProcessError(1, 'cosign')):
            with self.assertRaises(subprocess.CalledProcessError):
                delivery.sign_and_verify('example@sha256:' + 'a' * 64, [], 'predicate.json', type('Registry', (), {'http': True})(), {})

    def test_each_required_sbom_must_be_present(self):
        kind = 'https://spdx.dev/Document'
        ref = 'registry.example/app@sha256:' + 'a' * 64
        def envelope(predicate):
            statement = {'subject': [{'digest': {'sha256': 'a' * 64}}],
                         'predicateType': kind, 'predicate': predicate}
            return {'payload': base64.b64encode(json.dumps(statement).encode()).decode()}
        amd64, arm64 = {'name': 'amd64'}, {'name': 'arm64'}
        output = json.dumps([envelope(amd64), envelope(arm64)])
        delivery.verify_statements(output, ref, kind, [amd64, arm64])
        with self.assertRaises(ValueError):
            delivery.verify_statements(json.dumps(envelope(amd64)), ref, kind, [amd64, arm64])

    def test_registry_environment_must_agree(self):
        with patch.dict(os.environ, {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'other.example'}):
            with self.assertRaises(ValueError):
                delivery.Registry()

    def test_registry_publish_uses_put_and_binds_readback(self):
        submitted = b'{"schemaVersion":2}'
        for readback in (submitted, b'{"schemaVersion":1}'):
            calls = []
            def respond(request, timeout):
                calls.append(request)
                body = b'' if request.get_method() == 'PUT' else readback
                response = io.BytesIO(body)
                response.headers = {'Content-Type': delivery.MEDIA,
                                    'Docker-Content-Digest': 'sha256:' + hashlib.sha256(body).hexdigest()}
                return response
            with patch.dict(os.environ, {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example'}), \
                    patch.object(delivery.urllib.request, 'urlopen', side_effect=respond):
                registry = delivery.Registry()
                if readback == submitted:
                    self.assertEqual(registry.manifest('app', 'tag', submitted)[0],
                                     'sha256:' + hashlib.sha256(submitted).hexdigest())
                else:
                    with self.assertRaises(ValueError):
                        registry.manifest('app', 'tag', submitted)
            self.assertEqual([call.get_method() for call in calls], ['PUT', 'GET'])
            self.assertEqual(calls[0].data, submitted)


if __name__ == '__main__':
    unittest.main()
