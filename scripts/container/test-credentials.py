#!/usr/bin/env python3
"""Offline credential-copy contract; intercept the first write to inspect mode."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

ENTRYPOINT = Path(os.environ.get('TEST_ENTRYPOINT', Path(__file__).resolve().parents[2] / 'docker/claude-mem/entrypoint.sh'))

class CredentialTest(unittest.TestCase):
    def test_copy(self):
        for case in ('default', 'custom', 'permissive', 'symlink', 'directory-symlink', 'copy-failure', 'rename-failure', 'directory', 'missing'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / ('custom' if case == 'custom' else '.claude')
                config.mkdir()
                source = root / 'source.json'
                source.write_text('{"fixture":"not-a-provider-credential"}\n')
                source.chmod(0o444)
                original = source.read_bytes()
                destination = config / '.credentials.json'
                target = root / 'target'
                target.write_text('untouched')
                if case in ('permissive', 'copy-failure', 'rename-failure'):
                    destination.write_text('old')
                    destination.chmod(0o644)
                if case == 'symlink':
                    destination.symlink_to(target)
                if case == 'directory-symlink':
                    target.unlink()
                    target.mkdir()
                    destination.symlink_to(target, target_is_directory=True)
                if case == 'directory':
                    destination.mkdir()
                binaries = root / 'bin'
                binaries.mkdir()
                # stdout is the already-open destination, before cat writes bytes.
                probe = binaries / 'cat'
                probe.write_text('''#!/usr/bin/env python3
import os, stat, sys
from pathlib import Path
assert stat.S_IMODE(os.fstat(1).st_mode) == 0o600, 'Credential writable inode must be 0600 before first byte'
assert os.fstat(1).st_size == 0, 'Credential inode must be freshly created'
Path(os.environ['COPY_PROBE']).write_text('checked before write')
if os.environ['COPY_CASE'] == 'copy-failure':
    os.write(1, b'partial')
    sys.exit(23)
os.execv('/bin/cat', ['cat'] + sys.argv[1:])
''')
                probe.chmod(0o755)
                if case == 'rename-failure':
                    rename = binaries / 'mv'
                    rename.write_text('#!/bin/sh\nexit 24\n')
                    rename.chmod(0o755)
                env = dict(os.environ, HOME=str(root), CLAUDE_CONFIG_DIR=str(config),
                           CLAUDE_MEM_CONTAINER_MODE='shell',
                           CLAUDE_MEM_CREDENTIALS_FILE=str(root / 'missing' if case == 'missing' else source),
                           COPY_PROBE=str(root / 'probe'), COPY_CASE=case,
                           PATH=str(binaries) + ':' + os.environ['PATH'])
                # Exercise only the entrypoint, without ambient shell startup hooks.
                env.pop('BASH_ENV', None)
                if case == 'default':
                    env.pop('CLAUDE_CONFIG_DIR')
                result = subprocess.run(['bash', str(ENTRYPOINT), 'true'], env=env, capture_output=True, text=True)
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o444)
                self.assertEqual(list(config.glob('.credentials.json.*')), [])
                if case == 'missing':
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('file missing', result.stderr)
                elif case in ('copy-failure', 'rename-failure'):
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(destination.read_text(), 'old')
                elif case == 'directory':
                    self.assertNotEqual(result.returncode, 0)
                    self.assertTrue(destination.is_dir())
                    self.assertEqual(list(destination.iterdir()), [])
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue((root / 'probe').exists(), 'First-write permission probe was bypassed')
                    self.assertFalse(destination.is_symlink())
                    self.assertEqual(destination.read_bytes(), original)
                    self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
                if case == 'symlink':
                    self.assertEqual(target.read_text(), 'untouched')
                if case == 'directory-symlink':
                    self.assertEqual(list(target.iterdir()), [])

if __name__ == '__main__':
    unittest.main()
