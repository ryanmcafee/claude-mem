// SPDX-License-Identifier: Apache-2.0
//
// Remote corpus REST surface (MCAA-260, ADR 0001 D6).
//
// Registered by ServerV1PostgresRoutes so corpora share its auth, guards, audit
// and project-scope rules verbatim — the corpus endpoints are no exception to
// any of them. Request and response shapes come from
// src/server/contracts/corpus-v1.ts; nothing is retyped here (ADR condition 8).

import type { Application, Request, RequestHandler, Response } from 'express';
import {
  BuildCorpusRequestSchema,
  CORPUS_ERRORS,
  CORPUS_ID_PATHS,
  CORPUS_PATHS,
  CorpusNameSchema,
  GetCorpusQuerySchema,
  ListCorporaQuerySchema,
  QueryCorpusRequestSchema,
} from '../../contracts/corpus-v1.js';
import { CorpusOperationError, type CorpusService } from '../../services/CorpusService.js';
import { logger } from '../../../utils/logger.js';

export interface CorpusRouteDeps {
  service: CorpusService;
  readAuth: RequestHandler[];
  writeAuth: RequestHandler[];
  requireTeamId(req: Request, res: Response): string | null;
  ensureProjectAllowed(req: Request, res: Response, projectId: string): boolean;
  ensureSharedWriteAllowed(req: Request, res: Response): boolean;
  audit(
    req: Request,
    action: string,
    targetId: string | null,
    projectId: string | null,
    details?: Record<string, unknown>,
  ): Promise<void>;
  asyncHandler(fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler;
}

function sendValidationError(res: Response, issues: unknown): void {
  res.status(CORPUS_ERRORS.validation.status).json({
    error: CORPUS_ERRORS.validation.error,
    issues,
  });
}

/**
 * Turn a thrown service error into its contract response. Anything that is not
 * a CorpusOperationError is a bug, not a client mistake, so it answers 500 with
 * no internal detail — the log carries the cause.
 */
function sendServiceError(res: Response, error: unknown, action: string): void {
  if (error instanceof CorpusOperationError) {
    res.status(error.status).json(error.body);
    return;
  }
  const err = error instanceof Error ? error : new Error(String(error));
  logger.error('SYSTEM', `${action} failed`, { error: err.message });
  res.status(CORPUS_ERRORS.internal.status).json({
    error: CORPUS_ERRORS.internal.error,
    message: 'Corpus operation failed',
  });
}

/** `:name` is validated the same way the local CorpusStore validates it. */
function parseName(res: Response, raw: unknown): string | null {
  const parsed = CorpusNameSchema.safeParse(raw);
  if (!parsed.success) {
    sendValidationError(res, parsed.error.issues);
    return null;
  }
  return parsed.data;
}

export function registerCorpusRoutes(app: Application, deps: CorpusRouteDeps): void {
  const {
    service, readAuth, writeAuth, requireTeamId, ensureProjectAllowed,
    ensureSharedWriteAllowed, audit, asyncHandler,
  } = deps;

  /**
   * Resolve the tenant for a project-scoped corpus route. Returns null when it
   * has already answered (401/403), so callers just `return`.
   */
  function callerFor(req: Request, res: Response): { teamId: string; projectId: string } | null {
    const teamId = requireTeamId(req, res);
    if (!teamId) return null;
    const projectId = String(req.params.projectId);
    if (!ensureProjectAllowed(req, res, projectId)) return null;
    return { teamId, projectId };
  }

  // POST /v1/projects/:projectId/corpora — build, or rebuild in place.
  app.post(CORPUS_PATHS.collection, writeAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const parsed = BuildCorpusRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    // Publishing a corpus needs the same grant as publishing an observation.
    if (parsed.data.shared === true && !ensureSharedWriteAllowed(req, res)) return;
    try {
      const { corpus, created } = await service.build(caller, parsed.data);
      await audit(req, 'corpus.build', corpus.id, caller.projectId, {
        name: corpus.name,
        shared: corpus.shared,
        memberScope: corpus.memberScope,
        observationCount: corpus.stats.observationCount,
        matchedCount: corpus.stats.matchedCount,
        truncated: corpus.stats.truncated,
      });
      res.status(created ? 201 : 200).json({ corpus });
    } catch (error) {
      sendServiceError(res, error, 'corpus.build');
    }
  }));

  // GET /v1/projects/:projectId/corpora — list, optionally including corpora
  // other tenants published.
  app.get(CORPUS_PATHS.collection, readAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const parsed = ListCorporaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    const scope = parsed.data.scope ?? 'project';
    try {
      const corpora = await service.list(caller, { scope, limit: parsed.data.limit ?? 50 });
      await audit(req, 'corpus.read', null, caller.projectId, {
        mode: 'list', scope, resultCount: corpora.length,
      });
      res.status(200).json({ corpora, scope });
    } catch (error) {
      sendServiceError(res, error, 'corpus.list');
    }
  }));

  // GET /v1/projects/:projectId/corpora/:name — metadata, optionally with the
  // resolved member rows.
  app.get(CORPUS_PATHS.item, readAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    const parsed = GetCorpusQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    try {
      const corpus = await service.getByName(caller, name, {
        includeSources: parsed.data.include === 'sources',
      });
      await audit(req, 'corpus.read', corpus.id, caller.projectId, {
        mode: 'get', name, includeSources: parsed.data.include === 'sources',
      });
      res.status(200).json({ corpus });
    } catch (error) {
      sendServiceError(res, error, 'corpus.get');
    }
  }));

  // POST .../:name/rebuild — re-run the stored filter. Re-validates the
  // shared-member invariant, so a rebuild cannot smuggle in a private row.
  app.post(CORPUS_PATHS.rebuild, writeAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    try {
      const corpus = await service.rebuild(caller, name);
      await audit(req, 'corpus.rebuild', corpus.id, caller.projectId, {
        name, observationCount: corpus.stats.observationCount,
      });
      res.status(200).json({ corpus });
    } catch (error) {
      sendServiceError(res, error, 'corpus.rebuild');
    }
  }));

  // POST .../:name/prime — materialise the render. A write because it persists
  // an artifact row; deterministic, so repeating it converges.
  app.post(CORPUS_PATHS.prime, writeAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    try {
      const result = await service.prime(caller, { name });
      await audit(req, 'corpus.prime', result.corpus.id, caller.projectId, {
        name, contentDigest: result.contentDigest, alreadyPrimed: result.alreadyPrimed,
      });
      res.status(200).json({ ...result, session_id: null });
    } catch (error) {
      sendServiceError(res, error, 'corpus.prime');
    }
  }));

  // POST .../:name/reprime — drop the cached render and re-materialise.
  app.post(CORPUS_PATHS.reprime, writeAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    try {
      const result = await service.reprime(caller, name);
      await audit(req, 'corpus.reprime', result.corpus.id, caller.projectId, {
        name, contentDigest: result.contentDigest,
      });
      res.status(200).json({ ...result, session_id: null });
    } catch (error) {
      sendServiceError(res, error, 'corpus.reprime');
    }
  }));

  // POST .../:name/query — a read: it never mutates user-visible state, so a
  // read-only key can ask questions but not warm a corpus.
  app.post(CORPUS_PATHS.query, readAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    const parsed = QueryCorpusRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    try {
      const result = await service.query(caller, {
        name,
        question: parsed.data.question,
        history: parsed.data.history ?? [],
      });
      await audit(req, 'corpus.read', null, caller.projectId, {
        mode: 'query', name, contentDigest: result.contentDigest,
      });
      res.status(200).json({ ...result, session_id: null });
    } catch (error) {
      sendServiceError(res, error, 'corpus.query');
    }
  }));

  // DELETE .../:name — removes the corpus, its members and its artifacts.
  // Member observations are never touched.
  app.delete(CORPUS_PATHS.item, writeAuth, asyncHandler(async (req, res) => {
    const caller = callerFor(req, res);
    if (!caller) return;
    const name = parseName(res, req.params.name);
    if (name === null) return;
    try {
      await service.delete(caller, name);
      await audit(req, 'corpus.deleted', null, caller.projectId, { name });
      res.status(200).json({ deleted: true, name });
    } catch (error) {
      sendServiceError(res, error, 'corpus.delete');
    }
  }));

  // GET /v1/corpora/:corpusId — id-addressed read. Without it a corpus found
  // through ?scope=shared could be listed but never opened, and the list scope
  // would be dead weight (ADR D1). Read-only by construction.
  app.get(CORPUS_ID_PATHS.item, readAuth, asyncHandler(async (req, res) => {
    const teamId = requireTeamId(req, res);
    if (!teamId) return;
    const corpusId = String(req.params.corpusId);
    const parsed = GetCorpusQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    try {
      const corpus = await service.getById(
        { teamId, projectId: req.authContext?.projectId ?? '', projectScope: req.authContext?.projectId ?? null },
        corpusId,
        { includeSources: parsed.data.include === 'sources' },
      );
      // A foreign corpus no longer carries the owner's project id, so the audit
      // records the scope the caller acted under, as the id-addressed query does.
      await audit(req, 'corpus.read', corpus.id, corpus.projectId ?? req.authContext?.projectId ?? null, {
        mode: 'get', via: 'id', foreign: corpus.foreign,
      });
      res.status(200).json({ corpus });
    } catch (error) {
      sendServiceError(res, error, 'corpus.get');
    }
  }));

  // POST /v1/corpora/:corpusId/query — id-addressed query, same visibility rule.
  app.post(CORPUS_ID_PATHS.query, readAuth, asyncHandler(async (req, res) => {
    const teamId = requireTeamId(req, res);
    if (!teamId) return;
    const corpusId = String(req.params.corpusId);
    const parsed = QueryCorpusRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error.issues);
      return;
    }
    try {
      const result = await service.query(
        { teamId, projectId: req.authContext?.projectId ?? '', projectScope: req.authContext?.projectId ?? null },
        { corpusId, question: parsed.data.question, history: parsed.data.history ?? [] },
      );
      await audit(req, 'corpus.read', null, req.authContext?.projectId ?? null, {
        mode: 'query', via: 'id', contentDigest: result.contentDigest,
      });
      res.status(200).json({ ...result, session_id: null });
    } catch (error) {
      sendServiceError(res, error, 'corpus.query');
    }
  }));
}
