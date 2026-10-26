import base64
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('cosign_credentials', ROOT / 'ci/release.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class CosignCredentialTests(unittest.TestCase):
    def test_partial_creation_failure_removes_directory(self):
        for stage in ('chmod', 'open', 'write'):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / 'credentials'
                directory.mkdir(mode=0o700)
                target = {'chmod': 'chmod', 'open': 'open'}.get(stage)
                real_open = os.open

                def failed_open(path, *args, **kwargs):
                    if Path(path).name == 'config.json':
                        raise OSError('open failed')
                    return real_open(path, *args, **kwargs)

                def failed_write(data, output):
                    output.write('partial credential')
                    raise OSError('write failed')

                with ExitStack() as stack:
                    stack.enter_context(patch.object(delivery.tempfile, 'mkdtemp', return_value=str(directory)))
                    if target:
                        effect = failed_open if target == 'open' else OSError(stage + ' failed')
                        stack.enter_context(patch.object(delivery.os, target, side_effect=effect))
                    else:
                        stack.enter_context(patch.object(delivery.json, 'dump', side_effect=failed_write))
                    with self.assertRaisesRegex(OSError, stage + ' failed'):
                        delivery.create_cosign_docker_config_dir('registry.example', 'user', 'password')
                self.assertFalse(directory.exists())

    def test_cleanup_failure_is_propagated(self):
        with patch.object(delivery.shutil, 'rmtree', side_effect=OSError('cleanup failed')) as cleanup:
            with self.assertRaisesRegex(OSError, 'cleanup failed'):
                delivery.remove_cosign_docker_config_dir(Path('/unused/test-credentials'))
            cleanup.assert_called_once_with(Path('/unused/test-credentials'))

    def test_main_requires_signing_verification_and_cleanup_before_release_record(self):
        for failure in (None, 'sign', 'verify', 'create', 'cleanup'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                record = root / 'dist/release.json'
                record.parent.mkdir()
                record.write_text('stale release')
                credentials = root / 'credentials'
                mounts = root / 'mounts'
                mounts.mkdir()
                for name in ('password', 'cosign.key', 'cosign.pub', 'ca.crt', 'tls.crt', 'tls.key'):
                    (mounts / name).write_text('test-key')
                (root / 'ci').mkdir()
                (root / 'ci/cosign.pub').write_text('test-key')
                digest = 'sha256:' + 'a' * 64
                registry = Mock(host='registry.example', _user='ci', _password='test-secret')
                registry.manifest.return_value = (digest, b'{}', delivery.MEDIA)
                calls = []
                cleanup_seen = []
                real_create = delivery.create_cosign_docker_config_dir
                real_remove = delivery.remove_cosign_docker_config_dir

                def local_path(path):
                    path = Path(path)
                    if str(path).startswith(('/signing/', '/certs/')):
                        return mounts / path.name
                    return path if path.is_absolute() else root / path

                def create(*args):
                    credentials.mkdir(mode=0o700)
                    with patch.object(delivery.tempfile, 'mkdtemp', return_value=str(credentials)):
                        if failure == 'create':
                            def partial_write(data, output):
                                output.write('partial credential')
                                raise OSError('create failed')
                            with patch.object(delivery.json, 'dump', side_effect=partial_write):
                                return real_create(*args)
                        return real_create(*args)

                def cleanup(directory):
                    self.assertFalse(record.exists())
                    cleanup_seen.append(directory)
                    if failure == 'cleanup':
                        raise OSError('cleanup failed')
                    real_remove(directory)

                def run(*args, **kwargs):
                    if args[:2] == ('git', 'rev-parse'):
                        return 'b' * 40
                    if args[:3] == ('docker', 'buildx', 'build'):
                        local_path(args[args.index('--metadata-file') + 1]).write_text(
                            json.dumps({'containerimage.digest': digest}))
                    if args[0] == 'syft':
                        local_path(args[-1].split('=', 1)[1]).write_text('{}')
                    if args[0] != 'cosign':
                        return None
                    calls.append(args[1])
                    self.assertFalse(record.exists())
                    self.assertEqual(kwargs['env']['DOCKER_CONFIG'], str(credentials))
                    self.assertEqual(credentials.stat().st_mode & 0o777, 0o700)
                    self.assertEqual((credentials / 'config.json').stat().st_mode & 0o777, 0o600)
                    if args[1] == failure:
                        raise subprocess.CalledProcessError(1, args)
                    if args[1] == 'verify-attestation':
                        kind = args[args.index('--type') + 1]
                        predicate = (json.loads(local_path('dist/security/provenance.json').read_text())
                                     if kind == 'https://slsa.dev/provenance/v1' else {})
                        statement = {'subject': [{'digest': {'sha256': 'a' * 64}}],
                                     'predicateType': kind, 'predicate': predicate}
                        return json.dumps({'payload': base64.b64encode(json.dumps(statement).encode()).decode()})

                env = {'BUILD_NUMBER': '12', 'BUILDKIT_AMD64_NAME': 'builder',
                       'BUILDKIT_ARM64_NAME': 'builder', 'BUILDKIT_AMD64_ADDR': 'unused',
                       'BUILDKIT_ARM64_ADDR': 'unused'}
                with ExitStack() as stack:
                    stack.enter_context(patch.dict(os.environ, env, clear=True))
                    stack.enter_context(patch.object(delivery, 'Path', side_effect=local_path))
                    stack.enter_context(patch.object(delivery, 'Registry', return_value=registry))
                    stack.enter_context(patch.object(delivery, 'run', side_effect=run))
                    for name in ('unpack_chart', 'helm_push_chart', 'verify_chart_content'):
                        stack.enter_context(patch.object(delivery, name))
                    stack.enter_context(patch.object(delivery, 'architecture_manifest', return_value=digest))
                    stack.enter_context(patch.object(delivery, 'create_cosign_docker_config_dir', side_effect=create))
                    stack.enter_context(patch.object(delivery, 'remove_cosign_docker_config_dir', side_effect=cleanup))
                    if failure:
                        with self.assertRaises((OSError, subprocess.CalledProcessError)):
                            delivery.main()
                        self.assertFalse(record.exists())
                    else:
                        delivery.main()
                        self.assertEqual(json.loads(record.read_text())['imageDigest'], digest)
                        self.assertEqual(calls.count('sign'), 2)
                        self.assertEqual(calls.count('verify-attestation'), 4)
                self.assertEqual(cleanup_seen, [credentials])
                self.assertEqual(credentials.exists(), failure == 'cleanup')


if __name__ == '__main__':
    unittest.main()
