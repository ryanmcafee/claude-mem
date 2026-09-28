#!/usr/bin/env python3
"""Positive/negative contract tests for the release artifact binding gate."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

VERIFY = Path(__file__).with_name('verify-archive.py')

class ArchiveGateTest(unittest.TestCase):
    def fixture(self, path, sbom=True, corrupt=False, wrong_subject=False):
        blobs = {}
        def blob(value):
            data = json.dumps(value).encode()
            digest = hashlib.sha256(data).hexdigest()
            blobs[f'blobs/sha256/{digest}'] = data
            return {'digest': f'sha256:{digest}', 'size': len(data)}
        config = blob({'architecture': 'amd64', 'os': 'linux'})
        runtime = blob({'config': config, 'layers': []})
        runtime['platform'] = {'architecture': 'amd64', 'os': 'linux'}
        subject = [{'digest': {'sha256': ('0' * 64 if wrong_subject else runtime['digest'].split(':')[1])}}]
        layers = [blob({'predicateType': 'https://slsa.dev/provenance/v0.2', 'subject': subject})]
        if sbom:
            layers.append(blob({'predicateType': 'https://spdx.dev/Document', 'subject': subject}))
        attestation = blob({'layers': layers})
        attestation['annotations'] = {'vnd.docker.reference.digest': runtime['digest']}
        index = blob({'manifests': [runtime, attestation]})
        blobs['index.json'] = json.dumps({'manifests': [index]}).encode()
        if corrupt:
            blobs['blobs/sha256/' + runtime['digest'].split(':')[1]] = b'{}'
        with tarfile.open(path, 'w') as tar:
            for name, data in blobs.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return config['digest']

    def test_gate(self):
        cases = [('valid', True, False, False, 'linux/amd64', True),
                 ('missing SBOM', False, False, False, 'linux/amd64', False),
                 ('tampered manifest', True, True, False, 'linux/amd64', False),
                 ('different smoke image', True, False, True, 'linux/amd64', False),
                 ('wrong architecture', True, False, False, 'linux/arm64', False),
                 ('wrong subject', True, False, False, 'linux/amd64', False)]
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar'
            for name, sbom, corrupt, mismatch, platform, passes in cases:
                with self.subTest(name=name):
                    digest = self.fixture(archive, sbom, corrupt, name == 'wrong subject')
                    if mismatch:
                        digest = 'sha256:' + '0' * 64
                    result = subprocess.run(['python3', str(VERIFY), str(archive), digest, platform],
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, passes, result.stderr)

if __name__ == '__main__':
    unittest.main()
