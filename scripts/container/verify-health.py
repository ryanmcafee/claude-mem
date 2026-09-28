#!/usr/bin/env python3
"""Validate curl --include output without following redirects."""
import email.parser
import json
import sys


def verify(response):
    head, separator, body = response.partition(b'\r\n\r\n')
    if not separator:
        raise ValueError('missing HTTP header/body separator')
    status, _, headers = head.partition(b'\r\n')
    parts = status.split()
    if len(parts) < 2 or parts[0] != b'HTTP/1.1' or parts[1] != b'200':
        raise ValueError(f'expected HTTP/1.1 200, got {status!r}')
    parsed = email.parser.BytesParser().parsebytes(headers)
    values = parsed.get_all('Content-Type', [])
    if len(values) != 1 or values[0].split(';')[0].strip().lower() != 'application/json':
        raise ValueError(f'expected one application/json Content-Type, got {values!r}')
    payload = json.loads(body)
    if not isinstance(payload, dict) or payload.get('status') != 'ok' or payload.get('runtime') != 'server-beta':
        raise ValueError('expected JSON status=ok and runtime=server-beta')


if __name__ == '__main__':
    try:
        verify(sys.stdin.buffer.read())
    except (ValueError, UnicodeError) as error:
        sys.exit(f'/healthz contract failed: {error}')
    print('/healthz: HTTP/1.1 200; Content-Type application/json; status=ok; runtime=server-beta')
