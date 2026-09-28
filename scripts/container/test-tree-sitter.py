#!/usr/bin/env python3
"""Fail-closed and idempotence checks for container-only CLI adaptation."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

CONFIGURE = Path(__file__).with_name('configure-tree-sitter.cjs')
PACKAGES = [
    ('tree-sitter-cli', 'tree-sitter-cli', '0.26.9', 'node install.js'),
    ('tree-sitter-swift/node_modules/tree-sitter-cli', 'tree-sitter-cli', '0.23.2', 'node install.js'),
    ('@derekstride/tree-sitter-sql', '@derekstride/tree-sitter-sql', '0.3.11',
     'npx --yes --package=tree-sitter-cli@v0.24.7 -- tree-sitter generate && node-gyp-build'),
]

class NativeCliTest(unittest.TestCase):
    def test_contract(self):
        for case in ('valid', 'version drift', 'lifecycle drift', 'missing package'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for relative, name, version, install in PACKAGES:
                    file = root / relative / 'package.json'
                    file.parent.mkdir(parents=True)
                    file.write_text(json.dumps({'name': name, 'version': version,
                                                'scripts': {'install': install}}))
                target = root / PACKAGES[-1][0] / 'package.json'
                if case == 'missing package':
                    target.unlink()
                elif case != 'valid':
                    pkg = json.loads(target.read_text())
                    if case == 'version drift':
                        pkg['version'] = '999.0.0'
                    else:
                        pkg['scripts']['install'] = 'unexpected command'
                    target.write_text(json.dumps(pkg))
                before = {f: f.read_bytes() for f in root.rglob('package.json')}
                result = subprocess.run(['node', str(CONFIGURE), str(root)], capture_output=True, text=True)
                if case == 'valid':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    after = {f: f.read_bytes() for f in root.rglob('package.json')}
                    self.assertIn('/opt/tree-sitter/0.24.7/bin/tree-sitter generate', target.read_text())
                    again = subprocess.run(['node', str(CONFIGURE), str(root)], capture_output=True, text=True)
                    self.assertEqual(again.returncode, 0, again.stderr)
                    self.assertEqual(after, {f: f.read_bytes() for f in root.rglob('package.json')})
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('package.json', result.stderr)
                    self.assertEqual(before, {f: f.read_bytes() for f in root.rglob('package.json')})

if __name__ == '__main__':
    unittest.main()
