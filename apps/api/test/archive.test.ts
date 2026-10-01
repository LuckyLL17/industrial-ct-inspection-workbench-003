import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.ts';
import { archiveStore, _setCommitFault, hashContent, canonicalJson } from '../src/archive-store.ts';
import { setAnnotations, type Annotation } from '../src/domain.ts';

let app: FastifyInstance;

type Created = {
  duplicated: boolean;
  archiveId: string;
  status: string;
  releasable: boolean;
  gateStatus: string;
  blockingDefects: Array<{ id: string }>;
  contentHash: string;
  sourceFingerprint: string;
  message: string;
};

async function createArchive(init: RequestInit & { headers?: Record<string, string> } = {}) {
  const { payload, headers, ...rest } = init as RequestInit & {
    headers?: Record<string, string>; payload?: unknown;
  };
  const reply = await app.inject({
    method: 'POST',
    url: '/api/archives',
    headers: { 'content-type': 'application/json', ...headers },
    payload: payload === undefined ? {} : payload,
    ...rest
  });
  return { statusCode: reply.statusCode, body: reply.json<Created | { ok: boolean; error: string; archiveCount: number }>() };
}

beforeEach(async () => {
  archiveStore.reset();
  setAnnotations([
    { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
    { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
    { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
  ]);
  app = await buildApp();
});

test('健康检查与初始门禁：存在未接受的高风险缺陷时实时报告为 blocked', async () => {
  const health = await app.inject({ url: '/api/health' });
  assert.equal(health.statusCode, 200);
  const report = await app.inject({ url: '/api/report' });
  assert.equal(report.json<{ releaseGate: string }>().releaseGate, 'blocked');
});

test('高风险缺陷未接受时只能保存为 pending 待处理归档，不能标记为可签发', async () => {
  const res = await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-blocked-001' },
    payload: {
      note: '签发前证据冻结',
      // 尝试在请求体中伪造可签发状态，必须被服务端忽略
      status: 'releasable', releasable: true,
      releaseGate: { status: 'ready' }
    }
  });
  assert.equal(res.statusCode, 201);
  const body = res.body as Created;
  assert.equal(body.status, 'pending');
  assert.equal(body.releasable, false);
  assert.equal(body.gateStatus, 'blocked');
  assert.ok(body.message.includes('待处理归档'));
  assert.deepEqual(body.blockingDefects.map(item => item.id), ['D-044']);

  const detail = (await app.inject({ url: `/api/archives/${body.archiveId}` })).json<any>();
  assert.equal(detail.status, 'pending');
  assert.equal(detail.releasable, false);
  assert.equal(detail.snapshot.releaseGate.status, 'blocked');
});

test('归档快照不可变：归档后删除/新增标注、改复核状态，旧归档内容与哈希保持不变', async () => {
  const created = (await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-immutable-001' }
  })).body as Created;

  const before = (await app.inject({ url: `/api/archives/${created.archiveId}` })).json<any>();
  assert.equal(before.snapshot.defects.length, 3);
  assert.equal(before.contentHash, created.contentHash);

  // 实时数据持续变化：接受高风险缺陷 + 删除一个缺陷 + 新增一个缺陷
  await app.inject({ method: 'POST', url: '/api/annotations/D-044/review', payload: { status: 'accepted', reviewer: '王工' } });
  await app.inject({ method: 'DELETE', url: '/api/annotations/D-031' });
  await app.inject({
    method: 'POST', url: '/api/annotations',
    payload: { axis: 'axial', index: 10, x: 10, y: 10, kind: '裂纹', severity: '高', note: '新出现裂纹', diameter: 2.9 }
  });

  const liveReport = (await app.inject({ url: '/api/report' })).json<any>();
  assert.equal(liveReport.annotations.length, 3, '实时数据确实已变化');

  const after = (await app.inject({ url: `/api/archives/${created.archiveId}` })).json<any>();
  assert.equal(after.snapshot.defects.length, 3, '旧归档仍保留归档时刻的 3 个缺陷');
  assert.deepEqual(
    after.snapshot.defects.find((item: Annotation) => item.id === 'D-044').reviewStatus,
    'unreviewed',
    '旧归档中 D-044 仍为归档时刻的 unreviewed'
  );
  assert.equal(after.verification.verified, true);
  assert.equal(after.contentHash, before.contentHash, 'contentHash 不随实时数据变化');

  // 进程内直接尝试改写冻结快照必须抛错（fail-loud，防止内部代码污染历史）；
  // 注意必须验证存储里的对象本身，HTTP JSON 响应只是序列化副本。
  const stored = archiveStore.get(created.archiveId)!;
  assert.equal(Object.isFrozen(stored.snapshot), true);
  assert.throws(() => { stored.snapshot.defects.push({} as Annotation); }, TypeError);
  assert.throws(() => { stored.snapshot.capturedAt = 'x'; }, TypeError);
  assert.equal(stored.snapshot.defects.length, 3);
});

test('全部高风险缺陷被接受后创建的归档为 releasable，且不影响旧的 pending 归档', async () => {
  const first = (await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-seq-001' }
  })).body as Created;
  assert.equal(first.status, 'pending');

  await app.inject({ method: 'POST', url: '/api/annotations/D-044/review', payload: { status: 'accepted' } });

  const second = (await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-seq-002' }
  })).body as Created;
  assert.equal(second.status, 'releasable');
  assert.equal(second.releasable, true);
  assert.equal(second.gateStatus, 'ready');
  assert.notEqual(first.archiveId, second.archiveId);

  const old = (await app.inject({ url: `/api/archives/${first.archiveId}` })).json<any>();
  assert.equal(old.status, 'pending', '旧归档状态不被新门禁结果翻转');
});

test('幂等：相同 Idempotency-Key 串行重复提交与并发提交都只生成一条记录', async () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'key-idem-001' };
  const r1 = await createArchive({ headers, payload: { note: '一次签发动作' } });
  const r2 = await createArchive({ headers, payload: { note: '重试/刷新恢复' } });
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 200);
  assert.equal((r1.body as Created).duplicated, false);
  assert.equal((r2.body as Created).duplicated, true);
  assert.equal((r1.body as Created).archiveId, (r2.body as Created).archiveId);

  // 改变实时内容后，并发组成为「全新内容 + 全新 key」的干净场景，
  // 只可能由 key 去重合并（不再受内容级去重干扰）。
  await app.inject({ method: 'POST', url: '/api/annotations/D-044/review', payload: { status: 'accepted' } });
  const concurrent = await Promise.all([
    createArchive({ headers: { 'content-type': 'application/json', 'idempotency-key': 'key-idem-conc' }, payload: {} }),
    createArchive({ headers: { 'content-type': 'application/json', 'idempotency-key': 'key-idem-conc' }, payload: {} }),
    createArchive({ headers: { 'content-type': 'application/json', 'idempotency-key': 'key-idem-conc' }, payload: {} })
  ]);
  const ids = new Set(concurrent.map(item => (item.body as Created).archiveId));
  assert.equal(ids.size, 1, '三个并发请求指向同一条记录');
  assert.equal(concurrent.filter(item => (item.body as Created).duplicated === false).length, 1);
  assert.equal(concurrent.filter(item => (item.body as Created).duplicated === true).length, 2);
  assert.equal(concurrent.filter(item => item.statusCode === 201).length, 1);
  assert.equal(concurrent.filter(item => item.statusCode === 200).length, 2);

  const list = (await app.inject({ url: '/api/archives' })).json<{ archives: Array<{ archiveId: string }> }>();
  const concId = (concurrent[0].body as Created).archiveId;
  assert.equal(list.archives.filter(item => item.archiveId === concId).length, 1);
});

test('刷新恢复：丢失幂等键但实时内容未变，按 sourceFingerprint 去重，仍不产生重复记录', async () => {
  const r1 = await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'browser-session-A' }
  });
  const r2 = await createArchive({ headers: { 'content-type': 'application/json' }, payload: {} }); // 新会话，无 key
  assert.equal((r1.body as Created).archiveId, (r2.body as Created).archiveId);
  assert.equal((r2.body as Created).duplicated, true);
  assert.equal((await app.inject({ url: '/api/archives' })).json<{ total: number }>().total, 1);
});

test('内容级去重的边界：实时数据变化后指纹不同，允许生成新归档（新旧互不影响）', async () => {
  const r1 = await createArchive({ headers: { 'content-type': 'application/json' }, payload: {} });
  await app.inject({ method: 'DELETE', url: '/api/annotations/D-031' });
  const r2 = await createArchive({ headers: { 'content-type': 'application/json' }, payload: {} });
  assert.equal((r2.body as Created).duplicated, false);
  assert.notEqual((r1.body as Created).archiveId, (r2.body as Created).archiveId);
  assert.equal((r1.body as Created).sourceFingerprint === (r2.body as Created).sourceFingerprint, false);
});

test('创建失败（prepare/提交前注入故障）不产生任何记录，可用同一幂等键安全重试成功', async () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'key-fail-001' };

  for (const fault of ['before_prepare', 'after_hash_before_commit'] as const) {
    const failed = await createArchive({ headers: { ...headers, 'X-Test-Fault': fault }, payload: {} });
    assert.equal(failed.statusCode, 503, `${fault} 应返回 503`);
    assert.equal((failed.body as any).retriable, true);
    assert.equal((failed.body as any).archiveCount, 0, '失败后存储保持为空');
  }

  const list = (await app.inject({ url: '/api/archives' })).json<{ total: number }>();
  assert.equal(list.total, 0, '两次失败后仍无部分写入');

  // 同一幂等键重试 → 成功且只有一条
  const ok = await createArchive({ headers, payload: {} });
  assert.equal(ok.statusCode, 201);
  assert.equal((await app.inject({ url: '/api/archives' })).json<{ total: number }>().total, 1);

  // 再重放同一幂等键：仍然只拿到同一条，失败尝试没有“占用”幂等键产生半成品
  const replay = await createArchive({ headers, payload: {} });
  assert.equal(replay.statusCode, 200);
  assert.equal((replay.body as Created).archiveId, (ok.body as Created).archiveId);
});

test('列表 / 详情 / 下载读取同一份快照：哈希互证，下载文件可独立重算校验', async () => {
  const created = (await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-read-001' }
  })).body as Created;

  const list = (await app.inject({ url: '/api/archives' })).json<any>();
  const listed = list.archives[0];
  assert.equal(listed.verified, true);
  assert.equal(listed.contentHash, created.contentHash);
  assert.equal(listed.scanId, 'valve-housing-017');
  assert.equal(listed.blockingDefects.join(','), 'D-044');

  const detail = (await app.inject({ url: `/api/archives/${created.archiveId}` })).json<any>();
  assert.equal(detail.contentHash, listed.contentHash);
  assert.equal(detail.verification.verified, true);

  const download = await app.inject({ url: `/api/archives/${created.archiveId}/download` });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(download.headers['x-content-hash'], created.contentHash);
  assert.equal(download.headers['x-content-verified'], 'true');
  assert.match(String(download.headers['content-disposition']), new RegExp(created.archiveId));

  const file = JSON.parse(download.body) as any;
  assert.equal(file.archiveId, created.archiveId);
  // 下载到的文件离线重算哈希：与载荷自带 contentHash 一致
  assert.equal(hashContent(file.snapshot), file.contentHash);
  assert.equal(file.contentHash, detail.contentHash);
  // 三个视图的快照内容字节级一致（canonical 序列化后比较）
  assert.equal(canonicalJson(detail.snapshot), canonicalJson(file.snapshot));
});

test('篡改下载文件后重算哈希不通过；详情不存在返回 404', async () => {
  const created = (await createArchive({
    headers: { 'content-type': 'application/json', 'idempotency-key': 'key-tamper-001' }
  })).body as Created;
  const file = JSON.parse((await app.inject({ url: `/api/archives/${created.archiveId}/download` })).body) as any;
  file.snapshot.releaseGate.status = 'ready'; // 试图把待处理归档伪装成可签发
  assert.notEqual(hashContent(file.snapshot), file.contentHash, '篡改后哈希失配，伪造版本可被识别');

  const missing = await app.inject({ url: '/api/archives/AR-19990101-9999' });
  assert.equal(missing.statusCode, 404);
  const missingDownload = await app.inject({ url: '/api/archives/AR-19990101-9999/download' });
  assert.equal(missingDownload.statusCode, 404);
});

test('驳回的高风险缺陷同样阻断签发（accepted 是唯一放行条件）', async () => {
  await app.inject({ method: 'POST', url: '/api/annotations/D-044/review', payload: { status: 'rejected', reviewer: '王工' } });
  const res = await createArchive({ headers: { 'content-type': 'application/json', 'idempotency-key': 'key-reject-001' } });
  const body = res.body as Created;
  assert.equal(body.status, 'pending');
  assert.equal(body.blockingDefects[0].reviewStatus, 'rejected');
  assert.match(body.blockingDefects[0].reason, /驳回/);
});
