// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const AgentRoleSchema = z.enum(['author', 'review']);

const singleLine = z.string().trim().min(1).regex(/^[^\r\n]+$/, 'must be a single line');
const token = z.string().regex(/^\S+$/, 'must be a non-empty token without whitespace');

export const AttributionTrailersSchema = z.looseObject({
  agent: singleLine,
  agentId: token,
  run: token
});

export const AgentIdentitySchema = z.looseObject({
  subject: token,
  role: AgentRoleSchema,
  principalRef: z.string().min(1),
  attributionTrailers: AttributionTrailersSchema
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AttributionTrailers = z.infer<typeof AttributionTrailersSchema>;
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;
