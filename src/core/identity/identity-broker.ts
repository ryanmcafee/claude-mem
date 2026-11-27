// SPDX-License-Identifier: Apache-2.0

import { AgentRoleSchema, type AgentIdentity, type AgentRole } from './agent-identity.js';
import { noRunBindings, type RunBindingSource } from './verifier.js';

export interface IdentityRequest {
  runId: string;
  role: string;
}

export type IdentityDenial = 'unknown_role' | 'run_not_bound' | 'role_mismatch';

export type IdentityResult = { ok: true; identity: AgentIdentity } | { ok: false; reason: IdentityDenial };

export interface IdentityBroker extends RunBindingSource {
  requestIdentity(request: IdentityRequest): Promise<IdentityResult>;
}

export interface RunRoleBinding {
  runId: string;
  subject: string;
  agent: string;
  role: AgentRole;
}

export type BindRunRoleResult = { ok: true } | { ok: false; reason: 'role_already_bound' | 'no_principal_for_role' };

export function authorizeRole(bound: RunRoleBinding | undefined, requestedRole: string): IdentityDenial | null {
  const role = AgentRoleSchema.safeParse(requestedRole);
  if (!role.success) return 'unknown_role';
  if (!bound) return 'run_not_bound';
  return bound.role === role.data ? null : 'role_mismatch';
}

export interface InMemoryIdentityBrokerOptions {
  principals: Partial<Record<AgentRole, string>>;
  bindings?: RunBindingSource;
}

export interface InMemoryIdentityBroker extends IdentityBroker {
  bindRunRole(binding: RunRoleBinding): BindRunRoleResult;
}

export function createInMemoryIdentityBroker({
  principals,
  bindings = noRunBindings
}: InMemoryIdentityBrokerOptions): InMemoryIdentityBroker {
  const runRoles = new Map<string, RunRoleBinding>();

  return {
    bindingsFor: (object) => bindings.bindingsFor(object),

    bindRunRole(binding) {
      if (!principals[binding.role]) return { ok: false, reason: 'no_principal_for_role' };
      const existing = runRoles.get(binding.runId);
      if (existing) {
        const identical =
          existing.role === binding.role && existing.subject === binding.subject && existing.agent === binding.agent;
        return identical ? { ok: true } : { ok: false, reason: 'role_already_bound' };
      }
      runRoles.set(binding.runId, { ...binding });
      return { ok: true };
    },

    async requestIdentity({ runId, role }) {
      const bound = runRoles.get(runId);
      const denial = authorizeRole(bound, role);
      const principalRef = bound && principals[bound.role];
      if (denial || !bound || !principalRef) return { ok: false, reason: denial ?? 'run_not_bound' };

      return {
        ok: true,
        identity: {
          subject: bound.subject,
          role: bound.role,
          principalRef,
          attributionTrailers: { agent: bound.agent, agentId: bound.subject, run: bound.runId }
        }
      };
    }
  };
}
