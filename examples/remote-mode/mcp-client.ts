// SPDX-License-Identifier: Apache-2.0
//
// Generic MCP client against a remote claude-mem server over streamable HTTP.
// Nothing here is claude-mem-specific beyond the URL and the bearer header, so
// any MCP client (Claude Code, an agent framework, your own) connects the same
// way and gets the same tenant scoping.
//
//   export CLAUDE_MEM_SERVER_URL=https://claude-mem.example.com
//   export CLAUDE_MEM_API_KEY=cm_...
//   export CLAUDE_MEM_PROJECT_ID=homelab
//   bun examples/remote-mode/mcp-client.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveRemoteModeConfig } from '../../src/shared/remote-mode.js';

const config = resolveRemoteModeConfig();

const transport = new StreamableHTTPClientTransport(new URL(`${config.serverUrl}/v1/mcp`), {
  // The key authenticates AND scopes: the server resolves the team from it and
  // filters every read, so the client cannot reach another tenant's rows.
  requestInit: { headers: { Authorization: `Bearer ${config.apiKey}` } },
});

const client = new Client({ name: 'claude-mem-remote-example', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

function firstText(result: { content: unknown }): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  return blocks.find(block => block.type === 'text')?.text ?? '';
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map(tool => tool.name).join(', ')}`);

// Default scope: your own tenant only.
const own = await client.callTool({
  name: 'search',
  arguments: { projectId: config.projectId, query: 'argocd rollback', limit: 5 },
});
console.log('\nown tenant:');
console.log(firstText(own));

// Opt in to shared knowledge by naming the scope. Any other value narrows back
// to your own tenant, so this can only ever be deliberate.
const shared = await client.callTool({
  name: 'search',
  arguments: { projectId: config.projectId, query: 'argocd rollback', limit: 5, scope: 'shared' },
});
console.log('\nwith shared scope:');
console.log(firstText(shared));

// `context` returns the same observations plus a pre-joined string to inject.
const context = await client.callTool({
  name: 'context',
  arguments: { projectId: config.projectId, query: 'argocd rollback', limit: 3 },
});
console.log('\ncontext pack:');
console.log(firstText(context));

// `recent` needs no query — newest observations first.
const recent = await client.callTool({
  name: 'recent',
  arguments: { projectId: config.projectId, limit: 3 },
});
console.log('\nmost recent:');
console.log(firstText(recent));

await client.close();
