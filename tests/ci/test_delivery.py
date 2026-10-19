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
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
import urllib.error

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
        env = {'DOCKER_CONFIG': '/tmp/cosign-docker-config-test'}
        with patch.object(delivery, 'run', side_effect=subprocess.CalledProcessError(1, 'cosign')):
            with self.assertRaises(subprocess.CalledProcessError):
                delivery.sign_and_verify('example@sha256:' + 'a' * 64, [], 'predicate.json',
                                         type('Registry', (), {'http': True})(), env)

    def test_cosign_docker_config_dir_auth_and_cleanup(self):
        directory = delivery.create_cosign_docker_config_dir('registry.example:5000', 'push-user', 'push-pass')
        config_path = Path(directory) / 'config.json'
        self.assertTrue(config_path.is_file())
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
        auth = json.loads(config_path.read_text())['auths']['registry.example:5000']['auth']
        self.assertEqual(base64.b64decode(auth).decode(), 'push-user:push-pass')
        delivery.remove_cosign_docker_config_dir(directory)
        self.assertFalse(Path(directory).exists())

    def test_sign_and_verify_passes_docker_config_to_all_cosign_calls(self):
        docker_config = '/var/tmp/cosign-docker-config-unit-test'
        signing_env = {'DOCKER_CONFIG': docker_config, 'COSIGN_PASSWORD': 'secret'}
        captured = []
        predicate = delivery.provenance('abc', 'build-1')

        def fake_run(*args, capture=False, env=None):
            if args and args[0] == 'cosign':
                captured.append((args[1], (env or {}).get('DOCKER_CONFIG')))
            return '[]' if capture else None

        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle:
            json.dump(predicate, handle)
            predicate_path = handle.name
        try:
            with patch.object(delivery, 'run', side_effect=fake_run), \
                    patch.object(delivery, 'verify_statements'):
                delivery.sign_and_verify('example@sha256:' + 'a' * 64, [], predicate_path,
                                         type('Registry', (), {'http': True})(), signing_env)
        finally:
            Path(predicate_path).unlink(missing_ok=True)
        self.assertGreaterEqual(len(captured), 4)
        self.assertTrue(all(value == docker_config for _, value in captured))

    def test_cosign_docker_config_removed_after_signing_finally(self):
        directory = delivery.create_cosign_docker_config_dir('registry.example:5000', 'u', 'p')
        path = str(directory)
        seen = []

        def record_sign(*_args, **_kwargs):
            seen.append(Path(path).is_dir())

        try:
            with patch.object(delivery, 'sign_and_verify', side_effect=record_sign):
                delivery.sign_and_verify('ref', [], 'pred', None, {'DOCKER_CONFIG': path})
        finally:
            delivery.remove_cosign_docker_config_dir(directory)
        self.assertEqual(seen, [True])
        self.assertFalse(Path(path).exists())

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
        secret = 'registry-push-secret'
        for readback in (submitted, b'{"schemaVersion":1}'):
            calls = []
            def respond(request, timeout):
                calls.append(request)
                body = b'' if request.get_method() == 'PUT' else readback
                response = io.BytesIO(body)
                response.headers = {'Content-Type': delivery.MEDIA,
                                    'Docker-Content-Digest': 'sha256:' + hashlib.sha256(body).hexdigest()}
                return response
            env = {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example',
                   'ZOT_USER': 'ci-push', 'ZOT_PASS': secret}
            with patch.dict(os.environ, env, clear=False), \
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
            expected_auth = delivery.basic_auth_header('ci-push', secret)
            self.assertEqual(calls[0].get_header('Authorization'), expected_auth)
            self.assertNotIn(secret, str(calls))

    def test_registry_credentials_missing_fails_fast(self):
        with patch.dict(os.environ, {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example'},
                        clear=False):
            os.environ.pop('ZOT_USER', None)
            os.environ.pop('ZOT_PASS', None)
            os.environ.pop('DOCKER_CONFIG', None)
            with self.assertRaises(ValueError) as ctx:
                delivery.Registry()
            self.assertIn('credentials required', str(ctx.exception).lower())

    def test_registry_credentials_from_docker_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            auth = base64.b64encode(b'push-user:push-pass').decode()
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'auths': {'registry.example': {'auth': auth}}}))
            env = {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example',
                   'DOCKER_CONFIG': tmp}
            with patch.dict(os.environ, env, clear=False):
                os.environ.pop('ZOT_USER', None)
                os.environ.pop('ZOT_PASS', None)
                registry = delivery.Registry()
            self.assertEqual(registry._auth, delivery.basic_auth_header('push-user', 'push-pass'))

    def test_registry_credentials_from_docker_config_host_port_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            auth = base64.b64encode(b'zot-user:zot-pass').decode()
            host_port = 'zot.harbor.svc.cluster.local:5000'
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'auths': {host_port: {'auth': auth}}}))
            env = {'REGISTRY': host_port, 'CI_REGISTRY': host_port, 'DOCKER_CONFIG': tmp}
            with patch.dict(os.environ, env, clear=False):
                os.environ.pop('ZOT_USER', None)
                os.environ.pop('ZOT_PASS', None)
                registry = delivery.Registry()
            self.assertEqual(registry._auth, delivery.basic_auth_header('zot-user', 'zot-pass'))

    def test_manifest_put_requires_basic_auth_against_local_registry(self):
        user, password = 'ci-push', 'local-registry-secret'
        stored = {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def _authorized(self):
                header = self.headers.get('Authorization', '')
                return header == delivery.basic_auth_header(user, password)

            def do_PUT(self):
                if not self._authorized():
                    self.send_response(401)
                    self.end_headers()
                    return
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length)
                stored[self.path] = body
                digest = 'sha256:' + hashlib.sha256(body).hexdigest()
                self.send_response(201)
                self.send_header('Docker-Content-Digest', digest)
                self.send_header('Content-Type', delivery.MEDIA)
                self.end_headers()

            def do_GET(self):
                if not self._authorized():
                    self.send_response(401)
                    self.end_headers()
                    return
                body = stored.get(self.path, b'')
                digest = 'sha256:' + hashlib.sha256(body).hexdigest()
                self.send_response(200)
                self.send_header('Docker-Content-Digest', digest)
                self.send_header('Content-Type', delivery.MEDIA)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

        server = HTTPServer(('127.0.0.1', 0), Handler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        host = f'127.0.0.1:{port}'
        env = {'REGISTRY': host, 'CI_REGISTRY': host, 'CI_REGISTRY_INSECURE': 'true',
               'ZOT_USER': user, 'ZOT_PASS': password}
        payload = b'{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}'
        try:
            with patch.dict(os.environ, env, clear=False):
                registry = delivery.Registry()
                digest, _, _ = registry.manifest('app/test', 'tag', payload)
            self.assertEqual(digest, 'sha256:' + hashlib.sha256(payload).hexdigest())

            registry = delivery.Registry.__new__(delivery.Registry)
            registry.host = host
            registry.http = True
            registry.base = 'http://' + host
            registry._user = user
            registry._password = password
            registry._auth = 'Basic invalid'
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                registry.manifest('app/test', 'tag2', payload)
            self.assertEqual(ctx.exception.code, 401)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_helm_push_logs_in_with_password_stdin_and_logout_on_failure(self):
        registry = delivery.Registry.__new__(delivery.Registry)
        registry.host = 'registry.example'
        registry.http = True
        registry._user = 'ci-push'
        registry._password = 'helm-secret'
        calls = []

        def fake_run(args, **kwargs):
            calls.append({'args': list(args), 'kwargs': dict(kwargs)})
            return subprocess.CompletedProcess(args, 0)

        def fail_push(*args, **kwargs):
            raise subprocess.CalledProcessError(1, list(args), stderr='push failed with helm-secret')

        with patch.object(delivery.subprocess, 'run', side_effect=fake_run), \
                patch.object(delivery, 'run', side_effect=fail_push):
            with self.assertRaises(subprocess.CalledProcessError) as ctx:
                delivery.helm_push_chart(registry, 'dist/charts/war-table-1.tgz')
        login = next(c for c in calls if c['args'][:3] == ['helm', 'registry', 'login'])
        self.assertEqual(login['kwargs'].get('input'), 'helm-secret')
        self.assertNotIn('helm-secret', login['args'])
        self.assertTrue(any(c['args'][:3] == ['helm', 'registry', 'logout'] for c in calls))
        self.assertNotIn('helm-secret', (ctx.exception.stderr or '') + str(ctx.exception.cmd))


if __name__ == '__main__':
    unittest.main()
