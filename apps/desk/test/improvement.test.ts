import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createDirectory } from '../src/directory'
import type { Actor } from '../src/domain/types'
import { createImprovementControl } from '../src/improvement'

const owner: Actor = {
  id: 'operator-owner',
  email: 'owner@example.com',
  name: 'Owner',
  role: 'admin',
}

const reviewer: Actor = {
  id: 'operator-reviewer',
  email: 'reviewer@example.com',
  name: 'Independent Reviewer',
  role: 'admin',
}

describe('Improvement change control', () => {
  it('turns retained evidence into an evaluated but inactive proposal', async () => {
    let sequence = 0
    const random = { uuid: () => `improvement-test-id-${++sequence}` }
    const clock = { now: () => new Date('2026-07-18T16:00:00.000Z') }
    const directory = createDirectory({ db: env.DB, clock, random })
    const evidenceOperation = await directory.act(owner, {
      kind: 'adopt_external',
      intentId: 'intent-improvement-evidence',
      source: { module: 'helpdesk', entityType: 'customer', entityId: 'improvement-customer' },
      party: {
        kind: 'person',
        displayName: 'Improvement Customer',
        contactPoints: [{ kind: 'email', value: 'improvement@example.test', primary: true }],
      },
    })
    const improvements = createImprovementControl({ db: env.DB, clock, random })
    const proposed = await improvements.propose(owner, {
      intentId: 'intent-propose-followup-playbook-v2',
      scope: 'tenant',
      artifactKind: 'playbook',
      targetKey: 'crm.followup.confirmation',
      baseVersion: 'v1',
      candidateVersion: 'v2',
      evidence: [{ kind: 'operation_receipt', id: evidenceOperation.operationId }],
    })

    expect(proposed.proposal).toMatchObject({
      kind: 'improvement_proposal',
      scope: 'tenant',
      artifactKind: 'playbook',
      targetKey: 'crm.followup.confirmation',
      baseVersion: 'v1',
      candidateVersion: 'v2',
      status: 'proposed',
      evaluations: [],
      revision: expect.stringMatching(/^rev_/),
    })

    await expect(improvements.evaluate(owner, {
      intentId: 'intent-self-evaluate-followup-playbook-v2',
      proposalId: proposed.proposal.id,
      revision: proposed.proposal.revision,
      suiteVersion: 'tenant-followup-evals.v1',
      passed: true,
      report: { summary: 'A proposer cannot attest their own candidate.', metrics: {} },
    })).rejects.toThrow('different administrator')

    const evaluated = await improvements.evaluate(reviewer, {
      intentId: 'intent-evaluate-followup-playbook-v2',
      proposalId: proposed.proposal.id,
      revision: proposed.proposal.revision,
      suiteVersion: 'tenant-followup-evals.v1',
      passed: true,
      report: {
        summary: 'Targeted and regression cases passed in the isolated tenant fixture.',
        metrics: { targetedPassRate: 1, regressionPassRate: 1 },
      },
    })

    expect(evaluated.proposal).toMatchObject({
      id: proposed.proposal.id,
      status: 'evaluated',
      evaluations: [{
        suiteVersion: 'tenant-followup-evals.v1',
        passed: true,
        report: { metrics: { targetedPassRate: 1, regressionPassRate: 1 } },
      }],
    })
    expect(evaluated.proposal.revision).not.toBe(proposed.proposal.revision)
    expect(evaluated.proposal.evaluations[0]?.actor).toMatchObject({ id: reviewer.id })
    expect(await improvements.work(owner, proposed.proposal.id)).toEqual(evaluated.proposal)
    await expect(improvements.evaluate(reviewer, {
      intentId: 'intent-stale-followup-playbook-eval',
      proposalId: proposed.proposal.id,
      revision: proposed.proposal.revision,
      suiteVersion: 'tenant-followup-evals.v2',
      passed: true,
      report: { summary: 'This stale evaluation must not overwrite the proposal.', metrics: {} },
    })).rejects.toThrow('proposal changed')
  })
})
