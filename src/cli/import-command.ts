// SPDX-License-Identifier: Apache-2.0
//
// MCAA-241 — `claude-mem import`: migrate a local SQLite database into the
// central server.
//
// The command owns argument parsing, configuration resolution and reporting.
// The row work lives in src/services/import/sqlite-import.ts, and the tenant
// scope comes from the same resolution the hooks use (MCAA-237), so an import
// cannot reach a server the rest of the install is not already pointed at.
//
// Returns an exit code; the caller decides what to do with it.

import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { resolveDbPath } from '../shared/paths.js';
import { buildServerContext } from '../services/hooks/runtime-selector.js';
import { isRemoteModeConfigError } from '../shared/remote-mode.js';
import {
  importSqliteDatabase,
  SqliteImportSourceError,
  type ImportWriteClient,
  type ImportWriteRequest,
  type SqliteImportCounts,
  type SqliteImportResult,
} from '../services/import/sqlite-import.js';

const USAGE = `Usage: claude-mem import [options]

Migrate a local SQLite claude-mem database into the configured central server.
The import adds rows; it does not sync them. Re-running adds nothing: every row
carries a deterministic idempotency key, and the server reports repeats as
already present without comparing content, so edits made locally after the first
import are not carried over.

Options:
  --database <path>          Source database (default: the local claude-mem.db)
  --project <id>             Central project id to import into
                             (default: the configured project scope)
  --agent <id>               Agent identity recorded on every imported row
  --source-project <name>    Only import rows whose local project matches
                             (repeatable)
  --dry-run                  Report what would be sent without sending it
  -h, --help                 Show this help

Configuration comes from the environment first, then ~/.claude-mem/settings.json:
  CLAUDE_MEM_SERVER_URL, CLAUDE_MEM_API_KEY, CLAUDE_MEM_PROJECT_ID,
  CLAUDE_MEM_AGENT_ID
`;

interface ParsedImportArgs {
  databasePath: string;
  projectId: string | null;
  agentId: string | null;
  sourceProjects: string[];
  dryRun: boolean;
  help: boolean;
}

export function parseImportArgs(argv: string[]): ParsedImportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      database: { type: 'string' },
      project: { type: 'string' },
      agent: { type: 'string' },
      'source-project': { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  });
  const text = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    databasePath: text(values.database) ?? resolveDbPath(),
    projectId: text(values.project),
    agentId: text(values.agent),
    sourceProjects: Array.isArray(values['source-project'])
      ? values['source-project'].filter((value): value is string => typeof value === 'string')
      : [],
    dryRun: values['dry-run'] === true,
    help: values.help === true,
  };
}

/**
 * Bridges the importer onto the server's `/v1/memories` write path. Counts
 * responses that carry no `created` field so the command can warn: a server
 * that predates MCAA-241 ignores the idempotency key, which makes a second
 * import duplicate rows instead of skipping them.
 */
export class ServerImportWriteClient implements ImportWriteClient {
  responsesWithoutCreatedFlag = 0;

  constructor(
    private readonly write: (request: ImportWriteRequest) => Promise<{ created?: boolean }>,
  ) {}

  async addObservation(request: ImportWriteRequest): Promise<{ created: boolean }> {
    const response = await this.write(request);
    if (typeof response.created !== 'boolean') {
      this.responsesWithoutCreatedFlag += 1;
      return { created: true };
    }
    return { created: response.created };
  }
}

export async function runImportCommand(argv: string[]): Promise<number> {
  let args: ParsedImportArgs;
  try {
    args = parseImportArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 1;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  if (!existsSync(args.databasePath)) {
    console.error(`No local database at ${args.databasePath}.`);
    console.error('Pass --database <path> if the database lives somewhere else.');
    return 1;
  }

  let resolved: ReturnType<typeof buildServerContext>;
  try {
    resolved = buildServerContext();
  } catch (error) {
    if (isRemoteModeConfigError(error)) {
      console.error(`Central server configuration is incomplete: ${error.message}`);
      return 1;
    }
    throw error;
  }
  if (!resolved) {
    console.error('No central server is configured.');
    console.error('Set CLAUDE_MEM_SERVER_URL, CLAUDE_MEM_API_KEY and CLAUDE_MEM_PROJECT_ID, then retry.');
    return 1;
  }
  const context = resolved;

  const projectId = args.projectId ?? context.projectId;
  if (!projectId) {
    console.error('No project id: every imported row must carry a tenant scope.');
    console.error('Pass --project <id> or set CLAUDE_MEM_PROJECT_ID.');
    return 1;
  }

  const client = new ServerImportWriteClient(
    request => context.client.addObservation({
      projectId: request.projectId,
      kind: request.kind,
      content: request.content,
      metadata: request.metadata,
      agentId: request.agentId,
      idempotencyKey: request.idempotencyKey,
    }),
  );

  console.log(`Importing ${args.databasePath}`);
  console.log(`  into ${context.serverBaseUrl} project ${projectId}${args.dryRun ? ' (dry-run)' : ''}`);

  let result: SqliteImportResult;
  try {
    result = await importSqliteDatabase({
      databasePath: args.databasePath,
      projectId,
      agentId: args.agentId ?? context.agentId,
      sourceProjects: args.sourceProjects,
      dryRun: args.dryRun,
    }, client);
  } catch (error) {
    if (error instanceof SqliteImportSourceError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  printImportSummary(result);

  if (!args.dryRun && client.responsesWithoutCreatedFlag > 0) {
    console.warn(
      `\nWarning: the server did not report created/already-present for `
      + `${client.responsesWithoutCreatedFlag} write(s). It predates the idempotent `
      + '/v1/memories contract, so a second import would duplicate those rows. '
      + 'Upgrade the server before re-running.',
    );
  }

  if (result.totals.failed > 0) {
    console.error(`\n${result.totals.failed} row(s) failed. First failures:`);
    for (const failure of result.failures.slice(0, 5)) {
      console.error(`  ${failure.table}#${failure.rowId}: ${failure.error}`);
    }
    console.error('Re-run the import once the cause is fixed; imported rows will not be duplicated.');
    return 1;
  }
  return 0;
}

export function printImportSummary(result: SqliteImportResult): void {
  const line = (label: string, counts: SqliteImportCounts): string =>
    `  ${label.padEnd(18)} scanned ${counts.scanned}  imported ${counts.created}  `
    + `already present (content not compared) ${counts.alreadyPresent}  `
    + `skipped ${counts.skippedEmpty}  failed ${counts.failed}`;
  console.log(result.dryRun ? '\nImport (dry-run, nothing sent)' : '\nImport complete');
  console.log(line('observations', result.observations));
  console.log(line('session summaries', result.summaries));
  console.log(line('total', result.totals));
}
