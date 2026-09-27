// SPDX-License-Identifier: Apache-2.0
//
// Binds the corpus MCP tools to CorpusService for the /v1/mcp transport
// (MCAA-260). Same service, same tenant rules and same audit trail as the REST
// routes — the MCP path is no exception, exactly as for the recall tools.

import type { CorpusService } from '../services/CorpusService.js';
import type { CorpusBackend, CorpusRef, CorpusToolCaller } from './corpus-mcp-tools.js';

export type { CorpusBackend } from './corpus-mcp-tools.js';

export interface CorpusMcpBackendOptions {
  service: CorpusService;
  teamId: string;
  /** The API key's project scope, or null for a team-scoped key. */
  projectScope: string | null;
  /** Throws when the key may not touch `projectId`, mirroring ensureProjectAllowed. */
  assertProjectAllowed(projectId: string): void;
  /** Same audit hook the REST routes use, already bound to the request. */
  audit(action: string, targetId: string | null, projectId: string | null, details: Record<string, unknown>): Promise<void>;
  /** Allows write tools. A read-only link advertises the tools but refuses writes. */
  canWrite: boolean;
  canPublishShared: boolean;
}

export function createCorpusMcpBackend(options: CorpusMcpBackendOptions): CorpusBackend {
  const { service, teamId, projectScope } = options;

  function scoped(caller: CorpusToolCaller): { teamId: string; projectId: string; projectScope: string | null } {
    options.assertProjectAllowed(caller.projectId);
    return { teamId, projectId: caller.projectId, projectScope };
  }

  function assertWrite(tool: string): void {
    if (!options.canWrite) {
      throw new Error(`${tool} needs the "memories:write" scope; this API key is read-only.`);
    }
  }

  return {
    defaultProjectId: projectScope,

    async build(caller, request) {
      assertWrite('build_corpus');
      if (request.shared === true && !options.canPublishShared) {
        throw new Error('Publishing a corpus to the shared scope requires the "memories:write:shared" scope on this API key.');
      }
      const { corpus } = await service.build(scoped(caller), request);
      await options.audit('corpus.build', corpus.id, caller.projectId, {
        via: 'mcp', name: corpus.name, shared: corpus.shared, memberScope: corpus.memberScope,
      });
      return { corpus };
    },

    async list(caller, input) {
      const corpora = await service.list(scoped(caller), { scope: input.scope, limit: input.limit ?? 50 });
      await options.audit('corpus.read', null, caller.projectId, {
        via: 'mcp', mode: 'list', scope: input.scope, resultCount: corpora.length,
      });
      return { corpora, scope: input.scope };
    },

    async get(caller, ref, opts) {
      const corpus = ref.name !== undefined
        ? await service.getByName(scoped(caller), ref.name, opts)
        : await service.getById(scoped(caller), ref.corpusId, opts);
      await options.audit('corpus.read', corpus.id, corpus.projectId, {
        via: 'mcp', mode: 'get', foreign: corpus.foreign,
      });
      return { corpus };
    },

    async prime(caller, name) {
      assertWrite('prime_corpus');
      const result = await service.prime(scoped(caller), { name });
      await options.audit('corpus.prime', result.corpus.id, caller.projectId, {
        via: 'mcp', name, contentDigest: result.contentDigest, alreadyPrimed: result.alreadyPrimed,
      });
      return { ...result, session_id: null };
    },

    async query(caller, ref, input) {
      const result = await service.query(
        scoped(caller),
        ref.name !== undefined
          ? { name: ref.name, question: input.question, history: input.history }
          : { corpusId: ref.corpusId, question: input.question, history: input.history },
      );
      await options.audit('corpus.read', null, caller.projectId, {
        via: 'mcp', mode: 'query', name: result.name, contentDigest: result.contentDigest,
      });
      return { ...result, session_id: null };
    },

    async rebuild(caller, name) {
      assertWrite('rebuild_corpus');
      const corpus = await service.rebuild(scoped(caller), name);
      await options.audit('corpus.rebuild', corpus.id, caller.projectId, { via: 'mcp', name });
      return { corpus };
    },

    async reprime(caller, name) {
      assertWrite('reprime_corpus');
      const result = await service.reprime(scoped(caller), name);
      await options.audit('corpus.reprime', result.corpus.id, caller.projectId, {
        via: 'mcp', name, contentDigest: result.contentDigest,
      });
      return { ...result, session_id: null };
    },

    async delete(caller, name) {
      assertWrite('delete_corpus');
      await service.delete(scoped(caller), name);
      await options.audit('corpus.deleted', null, caller.projectId, { via: 'mcp', name });
      return { deleted: true, name };
    },
  } satisfies CorpusBackend & { defaultProjectId: string | null };
}

export type { CorpusRef };
