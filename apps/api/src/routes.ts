import type { FastifyInstance } from 'fastify';
import {
  annotations, setAnnotations, scan, workflow, stats, measurements, batchComparison,
  buildReleaseGate, type Annotation, type ReviewStatus
} from './domain.js';
import {
  archiveStore, serializeRecord, verifyRecord, hashContent, _setCommitFault,
  type ArchiveError, type CommitFault
} from './archive-store.js';

function slice(axis: string, index: number) {
  const size = 96;
  const data: number[][] = [];
  for (let y = 0; y < size; y++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) {
      const dx = x - 48, dy = y - 48;
      const shell = Math.sqrt(dx * dx + dy * dy);
      let value = 12 + Math.max(0, 1 - Math.abs(shell - 31) / 9) * 130 + Math.max(0, 1 - Math.abs(shell - 14) / 5) * 48;
      value += 16 * Math.sin((x + index) * .17) * Math.cos((y - index) * .12);
      const hole = (x - (57 + Math.sin(index * .15) * 4)) ** 2 + (y - (39 + Math.cos(index * .1) * 3)) ** 2;
      if (hole < 28 + (index - 42) ** 2 * .7) value = 8;
      const inclusion = (x - 30) ** 2 + (y - 61) ** 2;
      if (inclusion < 13 && axis !== 'sagittal') value = 220;
      row.push(Math.max(0, Math.min(255, Math.round(value))));
    }
    data.push(row);
  }
  return { axis, index, size, data };
}

function listSummary(record: ReturnType<typeof archiveStore.list>[number]) {
  const { snapshot } = record;
  return {
    archiveId: record.archiveId,
    status: record.status,
    releasable: record.releasable,
    idempotencyKey: record.idempotencyKey,
    sourceFingerprint: record.sourceFingerprint,
    contentHash: record.contentHash,
    note: record.note,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    capturedAt: snapshot.capturedAt,
    scanId: snapshot.scan.id,
    part: snapshot.scan.part,
    lot: snapshot.scan.lot,
    defectCount: snapshot.reviewState.defectCount,
    criticalCount: snapshot.reviewState.criticalCount,
    unreviewedCount: snapshot.reviewState.unreviewedCount,
    releaseGate: snapshot.releaseGate.status,
    blockingDefects: snapshot.releaseGate.blockingDefects.map(item => item.id),
    verified: verifyRecord(record)
  };
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // —— 既有实时数据接口（行为保持不变）——
  app.get('/api/health', async () => ({ status: 'ok', service: 'ct-inspection-workbench', version: '0.9.0' }));
  app.get('/api/scans/current', async () => scan);
  app.get('/api/scans/current/slice', async (request) => {
    const query = request.query as { axis?: string; index?: string };
    return slice(query.axis ?? 'axial', Math.max(0, Math.min(95, Number(query.index ?? 42))));
  });
  app.get('/api/workflow', async () => workflow);
  app.get('/api/annotations', async () => annotations);
  app.post('/api/annotations', async (request) => {
    const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'>;
    const item: Annotation = {
      ...body,
      id: `D-${String(annotations.length + 32).padStart(3, '0')}`,
      confidence: +(0.62 + Math.random() * .34).toFixed(2),
      reviewStatus: 'unreviewed',
      createdAt: new Date().toISOString()
    };
    setAnnotations([item, ...annotations]);
    return item;
  });
  app.post('/api/annotations/:id/review', async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { status: ReviewStatus; reviewer?: string; note?: string };
    const item = annotations.find(annotation => annotation.id === id);
    if (!item) return { ok: false, error: 'annotation_not_found' };
    item.reviewStatus = body.status;
    item.reviewer = body.reviewer ?? '王工';
    if (body.note) item.note = body.note;
    return item;
  });
  app.delete('/api/annotations/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    setAnnotations(annotations.filter(item => item.id !== id));
    return { ok: true };
  });
  app.get('/api/measurements', async () => measurements());
  app.get('/api/compare', async () => batchComparison());
  app.get('/api/report', async () => ({
    scan,
    workflow,
    summary: stats(),
    annotations,
    releaseGate: buildReleaseGate().status
  }));

  // —— 报告归档模块（独立于实时数据）——

  // 归档列表：读取已冻结快照，只返回摘要；verified 可用于刷新后校验本地/服务端结果。
  app.get('/api/archives', async () => ({
    total: archiveStore.size(),
    archives: archiveStore.list().map(listSummary)
  }));

  // 创建归档。
  //   状态由服务端依据快照门禁推导，请求体里的 status/releasable/releaseGate 一律忽略；
  //   Idempotency-Key（头或体）保证重复提交/刷新恢复不会生成多份记录；
  //   X-Test-Fault 仅供测试验证「prepare 失败无部分写入」，生产调用不要传。
  app.post('/api/archives', async (request, reply) => {
    const headers = request.headers as Record<string, string | undefined>;
    const fault = headers['x-test-fault'] as CommitFault | undefined;
    if (fault === 'before_prepare' || fault === 'after_hash_before_commit') {
      _setCommitFault(fault);
    }
    const body = (request.body ?? {}) as { idempotencyKey?: string; note?: string; createdBy?: string };
    const idempotencyKey = headers['idempotency-key'] ?? body.idempotencyKey ?? null;
    try {
      const { record, duplicated } = await archiveStore.create({
        idempotencyKey,
        note: body.note,
        createdBy: body.createdBy
      });
      const gate = record.snapshot.releaseGate;
      return reply
        .code(duplicated ? 200 : 201)
        .header('Idempotency-Replayed', duplicated ? 'true' : 'false')
        .send({
          duplicated,
          archiveId: record.archiveId,
          status: record.status,
          releasable: record.releasable,
          gateStatus: gate.status,
          blockingDefects: gate.blockingDefects,
          sourceFingerprint: record.sourceFingerprint,
          contentHash: record.contentHash,
          note: record.note,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
          message: gate.status === 'blocked'
            ? '已保存为待处理归档：高风险缺陷未被接受，不可作为可签发版本'
            : '归档已生成：门禁通过，为可签发版本'
        });
    } catch (error) {
      const code = (error as ArchiveError).code;
      if (code === 'snapshot_failed' || code === 'persist_failed') {
        // 原子提交失败：没有任何归档落库，客户端可用原幂等键安全重试。
        return reply.code(503).send({
          ok: false,
          error: code,
          message: (error as Error).message,
          retriable: true,
          archiveCount: archiveStore.size()
        });
      }
      throw error;
    } finally {
      _setCommitFault(null);
    }
  });

  // 归档详情：从同一冻结记录读取完整快照，并用 contentHash 验证未被篡改。
  app.get('/api/archives/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const record = archiveStore.get(id);
    if (!record) return reply.code(404).send({ ok: false, error: 'archive_not_found', archiveId: id });
    return {
      archiveId: record.archiveId,
      status: record.status,
      releasable: record.releasable,
      idempotencyKey: record.idempotencyKey,
      sourceFingerprint: record.sourceFingerprint,
      contentHash: record.contentHash,
      snapshot: record.snapshot,
      note: record.note,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      verification: { verified: verifyRecord(record), method: 'sha256(canonical snapshot)' }
    };
  });

  // 归档下载：与详情、列表读取同一份记录；直接重算哈希与载荷末尾的 contentHash
  // 不一致即可判定文件在流转中被改动。
  app.get('/api/archives/:id/download', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const record = archiveStore.get(id);
    if (!record) return reply.code(404).send({ ok: false, error: 'archive_not_found', archiveId: id });
    const payload = serializeRecord(record);
    const verified = hashContent(record.snapshot) === record.contentHash;
    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${record.archiveId}.json"`)
      .header('X-Archive-Id', record.archiveId)
      .header('X-Archive-Status', record.status)
      .header('X-Content-Hash', record.contentHash)
      .header('X-Content-Verified', String(verified))
      .send(payload);
  });
}
