#!/usr/bin/env node
// Container-only adaptation of locked package lifecycles to native musl CLIs.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw Error('Usage: configure-tree-sitter.cjs NODE_MODULES');
const specs = [
  ['tree-sitter-cli', 'tree-sitter-cli', '0.26.9', 'node install.js',
    'cp /opt/tree-sitter/0.26.9/bin/tree-sitter tree-sitter'],
  ['tree-sitter-swift/node_modules/tree-sitter-cli', 'tree-sitter-cli', '0.23.2',
    'node install.js', 'cp /opt/tree-sitter/0.23.2/bin/tree-sitter tree-sitter'],
  ['@derekstride/tree-sitter-sql', '@derekstride/tree-sitter-sql', '0.3.11',
    'npx --yes --package=tree-sitter-cli@v0.24.7 -- tree-sitter generate && node-gyp-build',
    '/opt/tree-sitter/0.24.7/bin/tree-sitter generate && node-gyp-build'],
];
// Validate every package before writing any: dependency updates require review.
const updates = specs.map(([directory, name, version, original, replacement]) => {
  const file = path.join(root, directory, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.name !== name || pkg.version !== version ||
      ![original, replacement].includes(pkg.scripts?.install)) {
    throw Error(`Unexpected tree-sitter dependency at ${file}; review the pinned musl versions and install lifecycle before updating the container.`);
  }
  pkg.scripts.install = replacement;
  return [file, pkg];
});
for (const [file, pkg] of updates) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log('Configured pinned musl tree-sitter installers (runtime, Swift, SQL).');
