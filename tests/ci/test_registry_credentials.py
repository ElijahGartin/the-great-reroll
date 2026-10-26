import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('registry_credentials', ROOT / 'ci/release.py')
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class RegistryCredentialTests(unittest.TestCase):
    def resolve(self, host, auths, env=None):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / 'config.json').write_text(json.dumps({'auths': auths}))
            with patch.dict(os.environ, {'DOCKER_CONFIG': tmp, **(env or {})}, clear=True):
                return delivery.resolve_zot_credentials(host)

    def test_exact_authority_accepts_supported_key_forms_and_credentials(self):
        entries = [
            {'auth': base64.b64encode(b'push-user:push:password').decode('ascii')},
            {'username': 'push-user', 'password': 'push:password'},
        ]
        for host in ('registry.example', 'registry.example:5000'):
            for scheme in ('', 'http://', 'https://'):
                for entry in entries:
                    with self.subTest(host=host, scheme=scheme, entry=entry):
                        self.assertEqual(self.resolve(host, {scheme + host: entry}),
                                         ('push-user', 'push:password'))

    def test_credentials_do_not_cross_registry_authorities(self):
        pairs = [
            ('registry.example:5000', 'registry.example'),
            ('registry.example', 'registry.example:5000'),
            ('registry.example:5000', 'registry.example:5001'),
            ('registry.example:5001', 'registry.example:5000'),
            ('registry.example', 'registry.example:443'),
            ('registry.example:443', 'registry.example'),
            ('registry.example', 'other.example'),
        ]
        for host, other in pairs:
            for scheme in ('', 'http://', 'https://'):
                with self.subTest(host=host, key=scheme + other):
                    with self.assertRaisesRegex(ValueError, 'no auths entry'):
                        self.resolve(host, {scheme + other: {'username': 'other', 'password': 'secret'}})

    def test_malformed_path_and_prefix_keys_do_not_match(self):
        for host in ('registry.example', 'registry.example:5000'):
            keys = [
                host + '/', host + '/v1/', host + ':', host + ':bad',
                host + ':5001/path', host + '.evil.example', host + '?query', host + '#fragment',
                'user@' + host, ' ' + host, host + ' ', 'prefix-' + host,
            ]
            for key in keys:
                for scheme in ('', 'http://', 'https://'):
                    with self.subTest(host=host, key=scheme + key):
                        with self.assertRaisesRegex(ValueError, 'no auths entry'):
                            self.resolve(host, {scheme + key: {'username': 'other', 'password': 'secret'}})
            for scheme in ('ftp://', 'oci://', 'https://https://'):
                with self.subTest(host=host, scheme=scheme):
                    with self.assertRaisesRegex(ValueError, 'no auths entry'):
                        self.resolve(host, {scheme + host: {'username': 'other', 'password': 'secret'}})

    def test_exact_key_has_precedence_over_scheme_keys_and_other_authorities(self):
        auths = {key: {'username': key, 'password': 'secret'} for key in (
            'registry.example:5001', 'registry.example', 'https://registry.example:5000',
            'http://registry.example:5000', 'registry.example:5000')}
        self.assertEqual(self.resolve('registry.example:5000', auths),
                         ('registry.example:5000', 'secret'))

    def test_complete_environment_credentials_take_precedence(self):
        self.assertEqual(self.resolve('registry.example:5000', {},
                                      {'ZOT_USER': 'env-user', 'ZOT_PASS': 'env-password'}),
                         ('env-user', 'env-password'))

    def test_incomplete_environment_credentials_use_exact_config_entry(self):
        for env in ({'ZOT_USER': 'env-user'}, {'ZOT_PASS': 'env-password'}):
            with self.subTest(env=env):
                self.assertEqual(self.resolve('registry.example:5000', {
                    'registry.example:5000': {'username': 'config-user', 'password': 'config-password'},
                }, env), ('config-user', 'config-password'))

    def test_empty_or_unusable_exact_entry_does_not_fall_back_to_another_authority(self):
        for entry in ({}, {'username': 'incomplete'}, {'auth': base64.b64encode(b'user:').decode('ascii')}):
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(ValueError, 'no auths entry'):
                    self.resolve('registry.example:5000', {
                        'registry.example:5000': entry,
                        'registry.example': {'username': 'other', 'password': 'secret'},
                    })


if __name__ == '__main__':
    unittest.main()
