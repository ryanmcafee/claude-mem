#!/usr/bin/env python3
"""The HTTP gate must reject redirects, errors, incorrect media and bodies."""
from pathlib import Path
import subprocess
import unittest

VERIFY = Path(__file__).with_name('verify-health.py')


class HealthGateTest(unittest.TestCase):
    def test_contract(self):
        good = b'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"status":"ok","runtime":"server-beta"}'
        cases = [
            ('valid', good, True),
            ('redirect', good.replace(b'200 OK', b'302 Found'), False),
            ('error', good.replace(b'200 OK', b'503 Unavailable'), False),
            ('wrong type', good.replace(b'application/json', b'text/html'), False),
            ('missing type', good.replace(b'Content-Type:', b'X-Content-Type:'), False),
            ('duplicate type', good.replace(b'Content-Type:', b'Content-Type: text/html\r\nContent-Type:'), False),
            ('bad json', good[:-1], False),
            ('unhealthy', good.replace(b'"ok"', b'"error"'), False),
            ('wrong runtime', good.replace(b'server-beta', b'worker'), False),
            ('empty', b'', False),
        ]
        for name, response, expected in cases:
            with self.subTest(name=name):
                result = subprocess.run(['python3', str(VERIFY)], input=response, capture_output=True)
                self.assertEqual(result.returncode == 0, expected, result.stderr)
                if not expected:
                    self.assertIn(b'/healthz contract failed:', result.stderr)


if __name__ == '__main__':
    unittest.main()
