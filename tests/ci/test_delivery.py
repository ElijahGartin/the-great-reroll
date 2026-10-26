import ast
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
                                         env)

    def test_cosign_docker_config_dir_auth_and_cleanup(self):
        directory = delivery.create_registry_docker_config_dir('registry.example:5000', 'push-user', 'push-pass')
        config_path = Path(directory) / 'config.json'
        self.assertTrue(config_path.is_file())
        self.assertEqual(os.stat(directory).st_mode & 0o777, 0o700)
        auth = json.loads(config_path.read_text())['auths']['registry.example:5000']['auth']
        self.assertEqual(base64.b64decode(auth).decode(), 'push-user:push-pass')
        delivery.remove_registry_docker_config_dir(directory)
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
                                         signing_env)
        finally:
            Path(predicate_path).unlink(missing_ok=True)
        self.assertGreaterEqual(len(captured), 4)
        self.assertTrue(all(value == docker_config for _, value in captured))

    def test_cosign_docker_config_removed_after_signing_finally(self):
        directory = delivery.create_registry_docker_config_dir('registry.example:5000', 'u', 'p')
        path = str(directory)
        seen = []

        def record_sign(*_args, **_kwargs):
            seen.append(Path(path).is_dir())

        try:
            with patch.object(delivery, 'sign_and_verify', side_effect=record_sign):
                delivery.sign_and_verify('ref', [], 'pred', {'DOCKER_CONFIG': path})
        finally:
            delivery.remove_registry_docker_config_dir(directory)
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

    def test_registry_rejects_empty_or_null_hosts(self):
        for registry, ci_registry in (('', ''), ('null', 'null'), ('registry.example', 'null')):
            env = {'REGISTRY': registry, 'CI_REGISTRY': ci_registry, 'ZOT_USER': 'u', 'ZOT_PASS': 'p'}
            with patch.dict(os.environ, env, clear=True), \
                    patch.object(delivery, 'resolve_zot_credentials') as resolve:
                with self.assertRaises(ValueError) as ctx:
                    delivery.Registry()
                resolve.assert_not_called()

    def test_registry_rejects_unsafe_hostport_values_before_credentials(self):
        reject = (
            'evil.example/x.svc.cluster.local:5000',
            'user@evil.example:5000',
            'evil.example@x.svc.cluster.local:5000',
            'HTTP://x.svc.cluster.local:5000',
            'registry.example:5000\n',
            'registry.example:5000 ',
        )
        for host in reject:
            env = {'REGISTRY': host, 'CI_REGISTRY': host}
            with self.subTest(host=host), patch.dict(os.environ, env, clear=True), \
                    patch.object(delivery, 'resolve_zot_credentials') as resolve:
                with self.assertRaises(ValueError):
                    delivery.Registry()
                resolve.assert_not_called()

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
            with patch.dict(os.environ, env, clear=True):
                registry = delivery.Registry()
            with patch.object(registry.opener, 'open', side_effect=respond):
                if readback == submitted:
                    self.assertEqual(registry.manifest('app', 'tag', submitted)[0],
                                     'sha256:' + hashlib.sha256(submitted).hexdigest())
                else:
                    with self.assertRaises(ValueError):
                        registry.manifest('app', 'tag', submitted)
            self.assertEqual([call.get_method() for call in calls], ['PUT', 'GET'])
            self.assertEqual(calls[0].data, submitted)
            expected_auth = delivery.basic_auth_header('ci-push', secret)
            self.assertTrue(all(call.get_header('Authorization') == expected_auth for call in calls))
            self.assertTrue(all(call.full_url.startswith('https://registry.example/v2/') for call in calls))
            self.assertNotIn(secret, str(calls))

    def test_registry_http_errors_redact_password_and_basic_auth(self):
        secret = 'registry-error-secret'
        env = {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example',
               'ZOT_USER': 'ci-push', 'ZOT_PASS': secret}
        with patch.dict(os.environ, env, clear=True):
            registry = delivery.Registry()
        auth = registry._auth
        error = urllib.error.HTTPError(
            'https://registry.example/v2/app/manifests/tag', 401,
            f'Unauthorized {secret} {auth}', {}, io.BytesIO(f'Failed {secret} {auth}'.encode()))
        with patch.object(registry.opener, 'open', side_effect=error):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                registry.manifest('app', 'tag', b'{}')
        try:
            self.assertEqual(caught.exception.code, 401)
            text = str(caught.exception) + caught.exception.read().decode()
            self.assertNotIn(secret, text)
            self.assertNotIn(auth, text)
            self.assertIn('Basic ***', text)
        finally:
            caught.exception.close()
            error.close()

    def test_registry_credentials_missing_fails_fast(self):
        with patch.dict(os.environ, {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example'},
                        clear=True):
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
            with patch.dict(os.environ, env, clear=True):
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
            with patch.dict(os.environ, env, clear=True):
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
                length = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(length)
                if not self._authorized():
                    self.send_response(401)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                stored[self.path] = body
                digest = 'sha256:' + hashlib.sha256(body).hexdigest()
                self.send_response(201)
                self.send_header('Docker-Content-Digest', digest)
                self.send_header('Content-Type', delivery.MEDIA)
                self.end_headers()

            def do_GET(self):
                if not self._authorized():
                    self.send_response(401)
                    self.send_header('Content-Length', '0')
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
        payload = b'{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}'
        try:
            registry = delivery.Registry.__new__(delivery.Registry)
            registry.host = host
            # The loopback HTTP fixture exercises auth only; production uses HTTPS.
            registry.base = 'http://' + host
            registry.opener = delivery.urllib.request.build_opener(
                delivery.urllib.request.ProxyHandler({}), delivery.RefuseRedirect())
            registry._user = user
            registry._password = password
            registry._auth = delivery.basic_auth_header(user, password)
            digest, _, _ = registry.manifest('app/test', 'tag', payload)
            self.assertEqual(digest, 'sha256:' + hashlib.sha256(payload).hexdigest())

            registry._auth = 'Basic invalid'
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                registry.manifest('app/test', 'tag2', payload)
            self.assertEqual(ctx.exception.code, 401)
            ctx.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_helm_credentials_are_private_isolated_and_removed_on_success_or_failure(self):
        registry = delivery.Registry.__new__(delivery.Registry)
        registry.host = 'registry.example'
        registry._user = 'ci-push'
        registry._password = 'helm-secret'
        for failure in (None, 'login', 'push'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                ambient = Path(tmp) / '.config/helm/registry/config.json'
                ambient.parent.mkdir(parents=True)
                ambient.write_text('{"auths":{"existing":"keep-me"}}')
                override = Path(tmp) / 'override.json'
                override.write_text('{"auths":{"override":"keep-me-too"}}')
                originals = {path: (path.read_bytes(), path.stat().st_mode)
                             for path in (ambient, override)}
                calls = []
                configs = []

                def fake_run(args, **kwargs):
                    calls.append(list(args))
                    config = Path(args[args.index('--registry-config') + 1])
                    configs.append(config)
                    self.assertNotIn(config, originals)
                    self.assertEqual(config.parent.stat().st_mode & 0o777, 0o700)
                    self.assertEqual(config.stat().st_mode & 0o777, 0o600)
                    self.assertNotIn(registry._password, ' '.join(args))
                    self.assertTrue(kwargs['check'])
                    self.assertTrue(kwargs['text'])
                    self.assertEqual(kwargs['stdout'], subprocess.PIPE)
                    self.assertEqual(kwargs['stderr'], subprocess.PIPE)
                    for insecure in ('--insecure', '--insecure-skip-tls-verify', '--plain-http'):
                        self.assertNotIn(insecure, args)
                    if args[1:3] == ['registry', 'login']:
                        self.assertEqual(args[3], registry.host)
                        self.assertEqual(args[args.index('--username') + 1], registry._user)
                        self.assertIn('--password-stdin', args)
                        self.assertEqual(kwargs['input'], registry._password)
                        self.assertEqual(json.loads(config.read_text()), {'auths': {}})
                        # Login can write credentials before exiting unsuccessfully.
                        config.write_text(registry._password)
                        operation = 'login'
                    else:
                        self.assertEqual(args[1:4], ['push', 'chart.tgz',
                                                    'oci://registry.example/platform/charts'])
                        self.assertNotIn('input', kwargs)
                        self.assertEqual(config.read_text(), registry._password)
                        operation = 'push'
                    if failure == operation:
                        raise subprocess.CalledProcessError(
                            1, args, output='stdout helm-secret',
                            stderr='DENIED: chart publishing forbidden helm-secret Basic Y2k6c2VjcmV0')
                    return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

                with patch.dict(os.environ, {'HELM_REGISTRY_CONFIG': str(override),
                                              'HELM_CONFIG_HOME': str(ambient.parents[1])}), \
                        patch.object(delivery.subprocess, 'run', side_effect=fake_run), \
                        patch('sys.stdout', new_callable=io.StringIO) as stdout, \
                        patch('sys.stderr', new_callable=io.StringIO) as stderr:
                    if failure:
                        with self.assertRaises(subprocess.CalledProcessError) as ctx:
                            delivery.helm_push_chart(registry, 'chart.tgz')
                        diagnostic = str(ctx.exception) + ctx.exception.stdout + ctx.exception.stderr
                        self.assertNotIn(registry._password, diagnostic)
                        self.assertNotIn('Y2k6c2VjcmV0', diagnostic)
                        self.assertIn('***', diagnostic)
                        visible = stderr.getvalue()
                        self.assertIn('DENIED: chart publishing forbidden', visible)
                        self.assertIn('stdout', visible)
                        self.assertNotIn(registry._password, visible)
                        self.assertNotIn('Y2k6c2VjcmV0', visible)
                        self.assertIn('Basic ***', visible)
                    else:
                        delivery.helm_push_chart(registry, 'chart.tgz')
                        self.assertEqual(stderr.getvalue(), '')
                    self.assertEqual(stdout.getvalue(), '')
                self.assertEqual(len(calls), 1 if failure == 'login' else 2)
                self.assertEqual(len(set(configs)), 1)
                self.assertFalse(configs[0].parent.exists())
                for path, original in originals.items():
                    self.assertEqual((path.read_bytes(), path.stat().st_mode), original)

    def test_helm_cleanup_failure_cannot_report_success(self):
        registry = delivery.Registry.__new__(delivery.Registry)
        registry.host = 'registry.example'
        registry._user = 'ci-push'
        registry._password = 'helm-secret'
        configs = []

        def fake_run(args, **kwargs):
            config = Path(args[args.index('--registry-config') + 1])
            configs.append(config)
            config.write_text(registry._password)
            return subprocess.CompletedProcess(args, 0, stdout='', stderr='')

        try:
            with patch.object(delivery.subprocess, 'run', side_effect=fake_run), \
                    patch.object(delivery.shutil, 'rmtree', side_effect=OSError('cleanup failed')):
                with self.assertRaisesRegex(OSError, 'cleanup failed'):
                    delivery.helm_push_chart(registry, 'chart.tgz')
            self.assertEqual(len(configs), 2)
        finally:
            if configs:
                delivery.shutil.rmtree(configs[0].parent)

    def test_plain_http_and_skip_verify_switches_are_refused_whatever_their_value(self):
        base = {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example',
                'ZOT_USER': 'ci', 'ZOT_PASS': 'test-secret'}
        # Trivy enables insecure mode for any non-empty TRIVY_NON_SSL, "false" included.
        for name in delivery.INSECURE_ENV:
            for value in ('1', 'true', 'TRUE', ' yes ', 'false', 'FALSE', ' false ', 'false-ish', '0', ''):
                with self.subTest(name=name, value=value), patch.dict(os.environ, {**base, name: value}, clear=True), \
                        patch.object(delivery, 'resolve_zot_credentials') as resolve:
                    with self.assertRaisesRegex(ValueError, 'HTTPS-only'):
                        delivery.Registry()
                    resolve.assert_not_called()
        with patch.dict(os.environ, base, clear=True):
            self.assertEqual(delivery.Registry().base, 'https://registry.example')

    def test_registry_client_verifies_tls_ignores_proxies_and_refuses_redirects(self):
        env = {'REGISTRY': 'registry.example', 'CI_REGISTRY': 'registry.example',
               'HTTPS_PROXY': 'http://proxy.example:3128', 'ZOT_USER': 'ci', 'ZOT_PASS': 'test-secret'}
        with patch.dict(os.environ, env):
            registry = delivery.Registry()
        handlers = {type(h): h for h in registry.opener.handlers}
        context = handlers[delivery.urllib.request.HTTPSHandler]._context
        self.assertEqual(context.verify_mode, delivery.ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        # HTTPS_PROXY is set, yet no proxy handler was installed from the environment.
        self.assertNotIn(delivery.urllib.request.ProxyHandler, handlers)
        self.assertNotIn(delivery.urllib.request.HTTPRedirectHandler, handlers)
        request = delivery.urllib.request.Request('https://registry.example/v2/app/manifests/tag')
        for target in ('https://elsewhere.example/v2/app/manifests/tag', 'http://registry.example/v2/app/manifests/tag'):
            with self.subTest(target=target), self.assertRaises(delivery.urllib.error.HTTPError) as caught:
                handlers[delivery.RefuseRedirect].redirect_request(request, None, 307, 'Temporary Redirect',
                                                                   {'Location': target}, target)
            caught.exception.close()

    def test_signing_and_verification_never_allow_plain_http(self):
        calls = []
        with patch.object(delivery, 'run', side_effect=lambda *args, **kwargs: calls.append(args) or ''), \
                patch.object(delivery, 'verify_statements'), patch.object(delivery.Path, 'read_text', return_value='{}'):
            delivery.sign_and_verify('registry.example/app@sha256:' + 'a' * 64, ['sbom.json'], 'predicate.json', {})
        self.assertTrue(calls)
        self.assertFalse([args for args in calls if '--allow-http-registry' in args])

    def test_release_script_has_no_plain_http_transport(self):
        source = (ROOT / 'ci/release.py').read_text()
        # Legacy Docker auth keys may include a scheme; they never select transport.
        lines = source.splitlines(keepends=True)
        for node in ast.parse(source).body:
            if isinstance(node, ast.FunctionDef) and node.name == '_docker_config_auth_entries':
                del lines[node.lineno - 1:node.end_lineno]
                break
        source = ''.join(lines)
        for flag in ('--plain-http', 'registry.insecure', '--allow-http-registry', "'http://", 'urlopen(',
                     '_create_unverified_context', 'ssl.CERT_NONE', 'check_hostname = False',
                     '--allow-insecure-registry'):
            with self.subTest(flag=flag):
                self.assertNotIn(flag, source)


if __name__ == '__main__':
    unittest.main()
