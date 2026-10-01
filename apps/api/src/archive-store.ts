// 报告归档存储。
//
// 写入策略：整份快照「原子提交」，不使用跨步骤补偿。
// create() 内部只有 prepare（组装+哈希+冻结+查重）与 commit（一次性入栈）两个阶段，
// 两阶段之间没有任何对外可见的部分写入；prepare 阶段抛出故障时存储状态保持不变，
// 无需补偿回滚。commit 只是进程内同步数组操作，不存在部分失败窗口。
//
// 幂等：
//   1) 相同 Idempotency-Key 的重复提交（含并发）只生成一条记录；
//   2) 同一扫描在相同实时内容上的重复提交（sourceFingerprint 相同）同样只生成一条记录，
//      这覆盖「刷新页面后丢失幂等键、按钮被再次点击」的恢复场景。
//
// 读取一致：列表 / 详情 / 下载全部从同一份已冻结记录读取，并可用 contentHash 交叉验证。

import { createHash } from 'node:crypto';
import { assembleSnapshot, deepClone, type ArchiveSnapshot } from './domain.js';

export type ArchiveStatus = 'releasable' | 'pending';

export type ArchiveRecord = {
  archiveId: string;
  status: ArchiveStatus;
  releasable: boolean;
  idempotencyKey: string | null;
  sourceFingerprint: string;
  contentHash: string;
  snapshot: ArchiveSnapshot;
  note: string;
  createdBy: string;
  createdAt: string;
};

export type CreateResult = { record: ArchiveRecord; duplicated: boolean };

export class ArchiveError extends Error {
  constructor(public code: 'snapshot_failed' | 'persist_failed', message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

// 测试可注入的提交故障点；生产路径下始终为 null。
export type CommitFault = 'before_prepare' | 'after_hash_before_commit';
let injectedFault: CommitFault | null = null;
export function _setCommitFault(fault: CommitFault | null): void {
  injectedFault = fault;
}

// 稳定序列化：字段名排序，避免对象插入顺序导致同内容哈希不同。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map(key => [key, sortValue((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function hashContent(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// 递归冻结：归档入库后，进程内任何代码都无法再改动这份快照，
// 误改会直接抛 TypeError，而不是静默污染历史归档。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value as object)) {
      const child = (value as Record<PropertyKey, unknown>)[key];
      if (child && typeof child === 'object') deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// sourceFingerprint 覆盖签发门禁关心的全部实时内容（不含归档精确时刻），
// 因此「相同实时状态重复归档」可以被识别；实时数据一变指纹即变。
// capturedAt 精确到毫秒，三个并发请求的时间戳互不相同，会绕过去重；
// 重复点击/刷新恢复发生在同一小时窗口内，故指纹使用小时粒度时间桶：
// 同小时+同实时内容 => 重复提交；跨小时即便内容相同也视为新一轮签发动作。
// 注意：contentHash 仍覆盖精确 capturedAt，时间桶只影响去重判断。
export function fingerprintSnapshot(snapshot: ArchiveSnapshot): string {
  const { capturedAt, ...content } = snapshot;
  return hashContent({ ...content, capturedAtBucket: capturedAt.slice(0, 13) });
}

const startedAt = Date.now();
let sequence = 0;
function nextArchiveId(now: Date): string {
  sequence += 1;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `AR-${yyyy}${mm}${dd}-${String(sequence).padStart(4, '0')}`;
}

export class ArchiveStore {
  private records: ArchiveRecord[] = [];
  private byId = new Map<string, ArchiveRecord>();
  private byKey = new Map<string, ArchiveRecord>();
  private byFingerprint = new Map<string, ArchiveRecord>();
  // 进行中提交：并发的相同幂等键共享同一个 Promise，只允许一次组装与提交。
  private inflight = new Map<string, Promise<CreateResult>>();

  list(): ArchiveRecord[] {
    // 逆序展示（最新在前），返回的仍是冻结记录本身。
    return [...this.records].reverse();
  }

  get(archiveId: string): ArchiveRecord | undefined {
    return this.byId.get(archiveId);
  }

  size(): number {
    return this.records.length;
  }

  // 仅供测试：重置进程内存储与故障注入。
  reset(): void {
    this.records = [];
    this.byId.clear();
    this.byKey.clear();
    this.byFingerprint.clear();
    this.inflight.clear();
    injectedFault = null;
  }

  async create(input: { idempotencyKey?: string | null; note?: string; createdBy?: string } = {}): Promise<CreateResult> {
    const idempotencyKey = input.idempotencyKey?.trim() || null;

    // 已完成的幂等键直接返回原记录，无论刷新/重试多少次都不会产生第二条。
    if (idempotencyKey) {
      const existing = this.byKey.get(idempotencyKey);
      if (existing) return { record: existing, duplicated: true };
      const pending = this.inflight.get(idempotencyKey);
      if (pending) {
        // 与进行中的提交合并：等待其结果，作为重复回放返回，绝不二次提交。
        const shared = await pending;
        return { record: shared.record, duplicated: true };
      }
    }

    const task = this.commit(input, idempotencyKey);
    if (idempotencyKey) {
      this.inflight.set(idempotencyKey, task);
      task.catch(() => undefined).finally(() => this.inflight.delete(idempotencyKey));
    }
    return task;
  }

  private async commit(input: { note?: string; createdBy?: string }, idempotencyKey: string | null): Promise<CreateResult> {
    // 模拟异步持久化边界，让并发去重（inflight 合并）可被真实触发。
    await Promise.resolve();

    // —— prepare 阶段：任何失败都发生在这里，存储一行数据都不会被写入 ——
    if (injectedFault === 'before_prepare') {
      throw new ArchiveError('snapshot_failed', '快照组装前注入故障：未写入任何归档');
    }

    let snapshot: ArchiveSnapshot;
    try {
      snapshot = assembleSnapshot();
    } catch (cause) {
      throw new ArchiveError('snapshot_failed', `快照组装失败，已放弃本次归档：${(cause as Error).message}`);
    }

    const sourceFingerprint = fingerprintSnapshot(snapshot);

    // 内容级去重：刷新后幂等键丢失也不会重复落库。
    const sameContent = this.byFingerprint.get(sourceFingerprint);
    if (sameContent) return { record: sameContent, duplicated: true };

    const contentHash = hashContent(snapshot);
    const now = new Date();
    const status: ArchiveStatus = snapshot.releaseGate.status === 'ready' ? 'releasable' : 'pending';
    const record: ArchiveRecord = {
      archiveId: nextArchiveId(now),
      status,
      // releasable 只能来自门禁事实：高风险未接受时恒为 false，无法被请求伪装。
      releasable: status === 'releasable',
      idempotencyKey,
      sourceFingerprint,
      contentHash,
      snapshot,
      note: input.note?.trim() || (status === 'releasable' ? '签发前 CT 证据归档' : '待处理归档：存在未放行的高风险缺陷'),
      createdBy: input.createdBy?.trim() || '质量负责人',
      createdAt: now.toISOString()
    };

    if (injectedFault === 'after_hash_before_commit') {
      throw new ArchiveError('persist_failed', '提交前注入故障：记录未入栈，无部分写入需要补偿');
    }

    // —— commit 阶段：一次性原子落库（栈 + 三个索引同处一个同步临界区）——
    this.records.push(record);
    this.byId.set(record.archiveId, record);
    if (idempotencyKey) this.byKey.set(idempotencyKey, record);
    this.byFingerprint.set(sourceFingerprint, record);
    deepFreeze(record);

    return { record, duplicated: false };
  }
}

export const archiveStore = new ArchiveStore();

// 详情/下载共用同一序列化出口：三个接口字节级一致，便于客户端用 contentHash 验证。
export function serializeRecord(record: ArchiveRecord): string {
  return canonicalJson({
    archiveId: record.archiveId,
    status: record.status,
    releasable: record.releasable,
    idempotencyKey: record.idempotencyKey,
    sourceFingerprint: record.sourceFingerprint,
    contentHash: record.contentHash,
    snapshot: record.snapshot,
    note: record.note,
    createdBy: record.createdBy,
    createdAt: record.createdAt
  });
}

export function verifyRecord(record: ArchiveRecord): boolean {
  return hashContent(record.snapshot) === record.contentHash &&
    fingerprintSnapshot(record.snapshot) === record.sourceFingerprint;
}

export { deepClone };
