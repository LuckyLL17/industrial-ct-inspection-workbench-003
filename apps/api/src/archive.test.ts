import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ArchiveError, ReportArchiveStore, type CreateArchiveInput, type ReportSnapshotContent } from './archive.js';

function validContent(evaluatedAt = '2026-10-01T00:00:00.000Z'): ReportSnapshotContent {
  return {
    scan: { id: 'S-1', part: '阀体', lot: 'LOT-1' },
    workflow: [{ id: 'review', status: 'pending' }],
    defects: [
      { id: 'D-1', kind: '裂纹', severity: '高', reviewStatus: 'unreviewed' }
    ],
    measurements: [{ annotationId: 'D-1', diameter: 3.42 }],
    lotComparison: { current: { highRisk: 1 }, previous: { highRisk: 0 } },
    summary: { defectCount: 1, highRiskCount: 1 },
    releaseGate: {
      status: 'blocked',
      canIssue: false,
      rule: '高风险必须接受',
      blockingDefects: [
        { id: 'D-1', kind: '裂纹', severity: '高', reviewStatus: 'unreviewed', reason: 'high_risk_not_accepted' }
      ],
      evaluatedAt
    }
  };
}

function validInput(overrides: Partial<CreateArchiveInput> = {}): CreateArchiveInput {
  return {
    idempotencyKey: 'key-pending-001',
    requestFingerprint: 'request-fingerprint',
    buildContent: () => validContent(),
    ...overrides
  };
}

describe('ReportArchiveStore', () => {
  it('saves an unaccepted high-risk defect as pending_review instead of release-ready', () => {
    const store = new ReportArchiveStore();
    const { archive } = store.create(validInput());

    assert.equal(archive.releaseGate.canIssue, false);
    assert.equal(archive.releaseGate.status, 'blocked');
    assert.equal(store.list()[0].archiveStatus, 'pending_review');
    assert.deepEqual(archive.releaseGate.blockingDefects, [
      { id: 'D-1', kind: '裂纹', severity: '高', reviewStatus: 'unreviewed', reason: 'high_risk_not_accepted' }
    ]);
  });

  it('rejects a snapshot that disguises blocked defects as issuable', () => {
    const store = new ReportArchiveStore();
    const content = validContent();
    content.releaseGate = { ...content.releaseGate, status: 'ready', canIssue: true, blockingDefects: [] };

    assert.throws(
      () => store.create(validInput({ buildContent: () => content })),
      (error: unknown) => error instanceof ArchiveError && error.code === 'invalid_release_gate'
    );
    assert.equal(store.list().length, 0);
  });

  it('leaves no archive or idempotency record when snapshot assembly fails', () => {
    const store = new ReportArchiveStore();

    assert.throws(
      () => store.create(validInput({
        idempotencyKey: 'key-failure-001',
        buildContent: () => { throw new Error('measurement service unavailable'); }
      })),
      (error: unknown) => error instanceof ArchiveError && error.code === 'snapshot_assembly_failed'
    );
    assert.equal(store.findByIdempotencyKey('key-failure-001'), undefined);
    assert.equal(store.list().length, 0);
  });

  it('returns the same archive for duplicate idempotent submissions', () => {
    const store = new ReportArchiveStore();
    const first = store.create(validInput());
    const second = store.create(validInput());

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.archive.archiveId, first.archive.archiveId);
    assert.equal(store.list().length, 1);
  });

  it('rejects the same idempotency key with a different request fingerprint', () => {
    const store = new ReportArchiveStore();
    store.create(validInput());

    assert.throws(
      () => store.create(validInput({ requestFingerprint: 'different-fingerprint' })),
      (error: unknown) => error instanceof ArchiveError && error.statusCode === 409 && error.code === 'idempotency_key_conflict'
    );
  });

  it('allows a release-ready archive only after every high-risk defect is accepted', () => {
    const store = new ReportArchiveStore();
    const input = validInput({
      idempotencyKey: 'key-ready-001',
      buildContent: () => {
        const content = validContent();
        content.defects[0].reviewStatus = 'accepted';
        content.releaseGate = {
          status: 'ready',
          canIssue: true,
          rule: '高风险必须接受',
          blockingDefects: [],
          evaluatedAt: '2026-10-01T00:00:00.000Z'
        };
        return content;
      }
    });

    const { archive } = store.create(input);
    assert.equal(archive.releaseGate.canIssue, true);
    assert.equal(store.list()[0].archiveStatus, 'release_ready');
  });

  it('freezes the assembled snapshot and isolates it from later live changes', () => {
    const store = new ReportArchiveStore();
    const { archive } = store.create(validInput());

    assert.equal(Object.isFrozen(archive), true);
    assert.equal(Object.isFrozen(archive.defects[0]), true);
    assert.throws(() => {
      (archive.defects[0] as { reviewStatus: string }).reviewStatus = 'accepted';
    }, TypeError);

    const fetched = store.get(archive.archiveId);
    assert.equal(fetched?.defects[0].reviewStatus, 'unreviewed');
  });

  it('requires an idempotency key for refresh recovery', () => {
    const store = new ReportArchiveStore();
    store.create(validInput({ idempotencyKey: 'key-refresh-001' }));

    assert.throws(
      () => store.findByIdempotencyKey('short'),
      (error: unknown) => error instanceof ArchiveError && error.code === 'invalid_idempotency_key'
    );
    assert.equal(store.findByIdempotencyKey('key-missing-001'), undefined);
    assert.equal(store.findByIdempotencyKey('key-refresh-001')?.idempotencyKey, 'key-refresh-001');
  });
});
