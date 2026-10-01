import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ArchiveError, ReportArchiveStore, createStableHash } from './archive.js';
import type { ArchivedDefect, ReportSnapshotContent } from './archive.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const reportArchives = new ReportArchiveStore();

type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';
type Annotation = { id: string; axis: string; index: number; x: number; y: number; kind: string; severity: string; note: string; diameter: number; confidence: number; reviewStatus: ReviewStatus; reviewer?: string; createdAt: string };
const scan = { id: 'valve-housing-017', part: '液压阀体 / VH-017', material: 'AlSi10Mg', resolution: '42 μm', dimensions: '128 × 128 × 96 voxels', operator: '张工', acquiredAt: '2026-09-30 08:42', scanner: 'Phoenix v|tome|x M 300', lot: 'LOT-2026-09-A17', standard: 'ASTM E1441' };
let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];
const workflow = [
  { id: 'ingest', label: '数据接收', status: 'done', owner: '系统', detail: '原始 DICOM 序列已校验' },
  { id: 'reconstruct', label: '体数据重建', status: 'done', owner: '算法服务', detail: '96 层切片已生成' },
  { id: 'primary', label: '初检标注', status: 'active', owner: '张工', detail: '存在 3 个候选缺陷' },
  { id: 'review', label: '二次复核', status: 'pending', owner: '王工', detail: '等待高风险裂纹复核' },
  { id: 'release', label: '报告签发', status: 'pending', owner: '质量负责人', detail: '需完成复核与判定' }
];
function slice(axis: string, index: number) { const size = 96; const data: number[][] = []; for (let y = 0; y < size; y++) { const row: number[] = []; for (let x = 0; x < size; x++) { const dx = x - 48, dy = y - 48; const shell = Math.sqrt(dx * dx + dy * dy); let value = 12 + Math.max(0, 1 - Math.abs(shell - 31) / 9) * 130 + Math.max(0, 1 - Math.abs(shell - 14) / 5) * 48; value += 16 * Math.sin((x + index) * .17) * Math.cos((y - index) * .12); const hole = (x - (57 + Math.sin(index * .15) * 4)) ** 2 + (y - (39 + Math.cos(index * .1) * 3)) ** 2; if (hole < 28 + (index - 42) ** 2 * .7) value = 8; const inclusion = (x - 30) ** 2 + (y - 61) ** 2; if (inclusion < 13 && axis !== 'sagittal') value = 220; row.push(Math.max(0, Math.min(255, Math.round(value)))); } data.push(row); } return { axis, index, size, data }; }
function isHighRisk(item: Pick<ArchivedDefect, 'severity'>): boolean {
  return item.severity === '高' || item.severity.toLowerCase() === 'high';
}
function stats(source: Annotation[] = annotations) { return { defectCount: source.length, criticalCount: source.filter(item => item.severity === '高').length, unreviewedCount: source.filter(item => item.reviewStatus !== 'accepted' && item.reviewStatus !== 'rejected').length, totalVolume: +source.reduce((sum, item) => sum + 4 / 3 * Math.PI * (item.diameter / 2) ** 3, 0).toFixed(2), byKind: Object.entries(source.reduce<Record<string, number>>((out, item) => { out[item.kind] = (out[item.kind] ?? 0) + 1; return out; }, {})).map(([kind, count]) => ({ kind, count })) }; }
function measurementsFor(source: Annotation[] = annotations) { return source.map(item => ({ annotationId: item.id, diameter: item.diameter, estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2), aspectRatio: +(1.1 + item.diameter * .24).toFixed(2), tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内' })); }
function lotComparisonFor(source: Annotation[] = annotations) {
  const defectCount = source.length;
  const highRisk = source.filter(isHighRisk).length;
  return { current: { scanId: scan.id, label: 'VH-017 / 本次扫描', defectCount, highRisk }, previous: { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 }, delta: { defectCount: defectCount - 2, highRisk } };
}
function releaseGateFor(source: Annotation[], evaluatedAt = new Date().toISOString()) {
  const blockingDefects = source
    .filter(item => isHighRisk(item) && item.reviewStatus !== 'accepted')
    .map(item => ({ id: item.id, kind: item.kind, severity: item.severity, reviewStatus: item.reviewStatus, reason: 'high_risk_not_accepted' as const }));
  const canIssue = blockingDefects.length === 0;
  return {
    status: canIssue ? 'ready' as const : 'blocked' as const,
    canIssue,
    rule: '所有高风险（severity=高/high）缺陷必须经复核接受（reviewStatus=accepted）后才可签发',
    blockingDefects,
    evaluatedAt
  };
}
function buildReportSnapshot(evaluatedAt: string): ReportSnapshotContent {
  const source = annotations.map(item => ({ ...item }));
  return {
    scan: { ...scan },
    workflow: structuredClone(workflow),
    defects: source,
    measurements: measurementsFor(source),
    lotComparison: lotComparisonFor(source),
    summary: stats(source),
    releaseGate: releaseGateFor(source, evaluatedAt)
  };
}
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ArchiveError) {
    request.log.warn({ code: error.code }, error.message);
    return reply.status(error.statusCode).send({ ok: false, code: error.code, message: error.message });
  }
  request.log.error(error);
  return reply.status(500).send({ ok: false, code: 'internal_error', message: error instanceof Error ? error.message : 'internal_error' });
});

app.get('/api/health', async () => ({ status: 'ok', service: 'ct-inspection-workbench', version: '0.9.0' }));
app.get('/api/scans/current', async () => scan);
app.get('/api/scans/current/slice', async (request) => { const query = request.query as { axis?: string; index?: string }; return slice(query.axis ?? 'axial', Math.max(0, Math.min(95, Number(query.index ?? 42)))); });
app.get('/api/workflow', async () => workflow);
app.get('/api/annotations', async () => annotations);
app.post('/api/annotations', async (request) => { const body = request.body as Omit<Annotation, 'id' | 'createdAt' | 'confidence' | 'reviewStatus'>; const item: Annotation = { ...body, id: `D-${String(annotations.length + 32).padStart(3, '0')}`, confidence: +(0.62 + Math.random() * .34).toFixed(2), reviewStatus: 'unreviewed', createdAt: new Date().toISOString() }; annotations = [item, ...annotations]; return item; });
app.post('/api/annotations/:id/review', async (request) => { const id = (request.params as { id: string }).id; const body = request.body as { status: ReviewStatus; reviewer?: string; note?: string }; const item = annotations.find(annotation => annotation.id === id); if (!item) return { ok: false, error: 'annotation_not_found' }; item.reviewStatus = body.status; item.reviewer = body.reviewer ?? '王工'; if (body.note) item.note = body.note; return item; });
app.delete('/api/annotations/:id', async (request) => { const id = (request.params as { id: string }).id; annotations = annotations.filter(item => item.id !== id); return { ok: true }; });
app.get('/api/measurements', async () => measurementsFor());
app.get('/api/compare', async () => lotComparisonFor());
app.get('/api/report', async () => ({ scan, workflow, summary: stats(), annotations, releaseGate: releaseGateFor(annotations) }));

// 报告归档：创建时完整复制实时数据；之后列表、详情、下载均只读取冻结快照。
app.get('/api/report-archives', async (_request, reply) => {
  return reply.send({ archives: reportArchives.list() });
});

app.get('/api/report-archives/by-idempotency-key', async (request, reply) => {
  const idempotencyKey = (request.query as { idempotencyKey?: string }).idempotencyKey;
  const archive = idempotencyKey ? reportArchives.findByIdempotencyKey(idempotencyKey) : undefined;
  if (!archive) {
    return reply.status(404).send({ ok: false, code: 'archive_not_found', message: '未找到对应幂等键的归档，创建请求未完成。' });
  }
  return reply.send({ archive, replayed: true });
});

app.post('/api/report-archives', async (request, reply) => {
  const headers = request.headers as Record<string, string | undefined>;
  const headerKey = headers['idempotency-key'];
  const body = (request.body ?? {}) as { idempotencyKey?: unknown; purpose?: unknown; createdBy?: unknown };
  if (headerKey !== undefined && body.idempotencyKey !== undefined && headerKey !== body.idempotencyKey) {
    throw new ArchiveError(400, 'idempotency_key_mismatch', '请求头与请求体中的幂等键不一致。');
  }
  const idempotencyKey = headerKey ?? (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
  if (!idempotencyKey) {
    throw new ArchiveError(400, 'idempotency_key_required', '创建归档必须提供 Idempotency-Key 请求头或 idempotencyKey 字段，以便安全重试。');
  }
  const purpose = body.purpose === undefined || body.purpose === null ? null : body.purpose;
  const createdBy = body.createdBy === undefined || body.createdBy === null ? null : body.createdBy;
  if ((purpose !== null && typeof purpose !== 'string') || (createdBy !== null && typeof createdBy !== 'string')) {
    throw new ArchiveError(400, 'invalid_archive_request', 'purpose 和 createdBy 必须为字符串。');
  }

  const requestFingerprint = createStableHash({ purpose, createdBy });
  const result = reportArchives.create({
    idempotencyKey,
    requestFingerprint,
    purpose,
    createdBy,
    buildContent: buildReportSnapshot
  });

  return reply.status(result.replayed ? 200 : 201).header('Idempotent-Replay', result.replayed ? 'true' : 'false').send({
    archive: result.archive,
    replayed: result.replayed,
    archiveStatus: result.archive.releaseGate.canIssue ? 'release_ready' : 'pending_review'
  });
});

app.get('/api/report-archives/:archiveId', async (request, reply) => {
  const { archiveId } = request.params as { archiveId: string };
  const archive = reportArchives.get(archiveId);
  if (!archive) {
    return reply.status(404).send({ ok: false, code: 'archive_not_found', message: '报告归档不存在。' });
  }
  return reply.send({ archive });
});

app.get('/api/report-archives/:archiveId/download', async (request, reply) => {
  const { archiveId } = request.params as { archiveId: string };
  const archive = reportArchives.get(archiveId);
  if (!archive) {
    return reply.status(404).send({ ok: false, code: 'archive_not_found', message: '报告归档不存在。' });
  }
  const serialized = JSON.stringify(archive, null, 2);
  return reply
    .type('application/json; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="ct-report-${archive.scan.id}-${archive.archiveId}.json"`)
    .header('X-Archive-Id', archive.archiveId)
    .header('X-Archive-Content-Hash', archive.contentHash)
    .send(serialized);
});
await app.listen({ port: 6182, host: '127.0.0.1' });
