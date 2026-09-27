#!/usr/bin/env python3
"""Bind the smoke-tested Docker config to the scanned, attested OCI archive."""
import hashlib
import json
import sys
import tarfile

archive, expected_config, platform = sys.argv[1:]
os_name, architecture = platform.split('/')
with tarfile.open(archive) as tar:
    def read(name):
        entry = tar.extractfile(name)
        if entry is None:
            raise ValueError(f'Missing OCI entry: {name}')
        return entry.read()

    def blob(descriptor):
        algorithm, digest = descriptor['digest'].split(':')
        if algorithm != 'sha256':
            raise ValueError(f'Unsupported digest: {algorithm}')
        content = read(f'blobs/sha256/{digest}')
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f'OCI digest mismatch: {digest}')
        return json.loads(content)

    def manifests(index):
        for descriptor in index['manifests']:
            document = blob(descriptor)
            if 'manifests' in document:
                yield from manifests(document)
            else:
                yield descriptor, document

    entries = list(manifests(json.loads(read('index.json'))))
    runtime = [(descriptor, manifest) for descriptor, manifest in entries
               if descriptor.get('platform', {}).get('os') == os_name
               and descriptor.get('platform', {}).get('architecture') == architecture]
    if len(runtime) != 1:
        raise ValueError(f'Expected exactly one {platform} runtime, found {len(runtime)}')
    descriptor, manifest = runtime[0]
    if manifest['config']['digest'] != expected_config:
        raise ValueError('Smoke-tested image differs from scanned OCI runtime config')
    predicates = set()
    for att_descriptor, att_manifest in entries:
        annotations = att_descriptor.get('annotations', {})
        if annotations.get('vnd.docker.reference.digest') != descriptor['digest']:
            continue
        for layer in att_manifest['layers']:
            statement = blob(layer)
            predicates.add(statement.get('predicateType', ''))
    if 'https://spdx.dev/Document' not in predicates:
        raise ValueError('Missing SPDX SBOM attestation for runtime image')
    if not any(p.startswith('https://slsa.dev/provenance/') for p in predicates):
        raise ValueError('Missing SLSA provenance attestation for runtime image')
print(f'{platform}: smoke config matches scanned OCI image; SPDX and SLSA present')
