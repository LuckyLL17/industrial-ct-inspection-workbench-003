import { createHash, randomUUID } from 'node:crypto';

export class ArchiveError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchivedDefect {
  id: string;
  kind: string;
  severity: string;
  reviewStatus: string;
  [key: string]: unknown;
}

export interface BlockingDefect {
  id: string;
  kind: string;
  severity: string;
  reviewStatus: string;
  reason: 'high_risk_not_accepted';
}

export interface ReleaseGate {
  status: 'ready' | 'blocked';
  canIssue: boolean;
  rule: string;
  blockingDefects: BlockingDefect[];
  evaluatedAt: string;
  [key: string]: unknown;
}

export interface ReportSnapshotContent {
  scan: Record<string, unknown>;
  workflow: unknown[];
  defects: ArchivedDefect[];
  measurements: unknown[];
  lotComparison: unknown;
  summary?: unknown;
  releaseGate: ReleaseGate;
}

export interface ArchivedReport extends ReportSnapshotContent {
  schemaVersion: 'report-archive.v1';
  archiveId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  purpose: string | null;
  createdBy: string | null;
  createdAt: string;
  contentHash: string;
}

export interface ArchiveSummary {
  archiveId: string;
  idempotencyKey: string;
  createdAt: string;
  archiveStatus: 'release_ready' | 'pending_review';
  canIssue: boolean;
  scanId: string | null;
  part: string | null;
  lot: string | null;
  defectCount: number;
  highRiskCount: number;
  blockingDefectCount: number;
  contentHash: string;
}

export interface CreateArchiveInput {
  idempotencyKey: string;
  requestFingerprint: string;
  purpose?: string | null;
  createdBy?: string | null;
  buildContent: (capturedAt: string) => ReportSnapshotContent;
}

export interface CreateArchiveResult {
  archive: ArchivedReport;
  replayed: boolean;
}

const KEY_PATTERN = /^[!-~]{8,200}$/;

export function createStableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value ?? null;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeForHash(item)]),
  );
}

function cloneSnapshot<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  return Object.freeze(value);
}

function isHighRisk(defect: ArchivedDefect): boolean {
  return defect.severity === '高' || String(defect.severity).toLowerCase() === 'high';
}

function text(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

/**
 * 报告归档采用“先完整组装、再单次原子提交”的策略。
 * buildContent 或快照校验失败前不会写入任何归档表；提交阶段在同一个
 * 同步临界区写入归档记录和幂等索引，因此不需要部分写入后的补偿恢复。
 */
export class ReportArchiveStore {
  private readonly archives = new Map<string, ArchivedReport>();
  private readonly idempotencyKeys = new Map<string, string>();

  create(input: CreateArchiveInput): CreateArchiveResult {
    this.validateKey(input.idempotencyKey);

    const existingId = this.idempotencyKeys.get(input.idempotencyKey);
    if (existingId !== undefined) {
      const existing = this.archives.get(existingId);
      if (!existing) {
        throw new ArchiveError(500, 'archive_index_corrupt', '归档索引指向了不存在的快照。');
      }
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new ArchiveError(409, 'idempotency_key_conflict', '相同幂等键提交了不同的归档请求。');
      }
      return { archive: existing, replayed: true };
    }

    const capturedAt = new Date().toISOString();
    let staged: ArchivedReport;

    try {
      const content = cloneSnapshot(input.buildContent(capturedAt));
      this.validateContent(content);

      const archiveId = randomUUID();
      const purpose = input.purpose ?? null;
      const createdBy = input.createdBy ?? null;
      const contentHash = createStableHash({
        schemaVersion: 'report-archive.v1',
        capturedAt,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        purpose,
        createdBy,
        content,
      });

      staged = deepFreeze({
        schemaVersion: 'report-archive.v1',
        archiveId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        purpose,
        createdBy,
        createdAt: capturedAt,
        contentHash,
        ...content,
      });
    } catch (error) {
      if (error instanceof ArchiveError) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : 'unknown_error';
      throw new ArchiveError(500, 'snapshot_assembly_failed', `归档快照组装失败：${detail}`);
    }

    // 原子提交点：两份内存结构在同一个同步临界区完成写入。
    if (this.idempotencyKeys.has(input.idempotencyKey) || this.archives.has(staged.archiveId)) {
      throw new ArchiveError(409, 'archive_already_exists', '归档在提交时检测到重复键。');
    }
    this.archives.set(staged.archiveId, staged);
    this.idempotencyKeys.set(input.idempotencyKey, staged.archiveId);

    return { archive: staged, replayed: false };
  }

  list(): ArchiveSummary[] {
    return Array.from(this.archives.values())
      .map((archive) => this.toSummary(archive))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(archiveId: string): ArchivedReport | undefined {
    return this.archives.get(archiveId);
  }

  findByIdempotencyKey(idempotencyKey: string): ArchivedReport | undefined {
    this.validateKey(idempotencyKey);
    const archiveId = this.idempotencyKeys.get(idempotencyKey);
    return archiveId === undefined ? undefined : this.archives.get(archiveId);
  }

  private validateKey(key: string): void {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new ArchiveError(400, 'invalid_idempotency_key', '幂等键必须为 8 至 200 个可打印 ASCII 字符。');
    }
  }

  private validateContent(content: ReportSnapshotContent): void {
    if (!content || typeof content !== 'object') {
      throw new ArchiveError(400, 'invalid_snapshot', '归档快照必须是对象。');
    }
    for (const field of ['scan', 'workflow', 'defects', 'measurements', 'lotComparison', 'releaseGate'] as const) {
      if (!(field in content)) {
        throw new ArchiveError(400, 'invalid_snapshot', `归档快照缺少 ${field}。`);
      }
    }
    if (typeof content.scan !== 'object' || content.scan === null || Array.isArray(content.scan)) {
      throw new ArchiveError(400, 'invalid_snapshot', '扫描信息必须是对象。');
    }
    if (!Array.isArray(content.workflow) || !Array.isArray(content.defects) || !Array.isArray(content.measurements)) {
      throw new ArchiveError(400, 'invalid_snapshot', '工作流、缺陷和尺寸测量必须是数组。');
    }
    if (content.lotComparison === null || typeof content.lotComparison !== 'object' || Array.isArray(content.lotComparison)) {
      throw new ArchiveError(400, 'invalid_snapshot', '炉次对比必须是对象。');
    }
    for (const defect of content.defects) {
      if (!defect || typeof defect !== 'object' || typeof defect.id !== 'string' || typeof defect.reviewStatus !== 'string' || typeof defect.severity !== 'string') {
        throw new ArchiveError(400, 'invalid_snapshot', '缺陷必须包含字符串类型的 id、severity 和 reviewStatus。');
      }
    }

    const blockingDefects = content.defects
      .filter((defect) => isHighRisk(defect) && defect.reviewStatus !== 'accepted')
      .map((defect) => ({
        id: defect.id,
        kind: defect.kind,
        severity: defect.severity,
        reviewStatus: defect.reviewStatus,
        reason: 'high_risk_not_accepted' as const,
      }));
    const canIssue = blockingDefects.length === 0;
    const gate = content.releaseGate;

    if (!gate || typeof gate !== 'object') {
      throw new ArchiveError(400, 'invalid_release_gate', '签发门禁必须是对象。');
    }
    if (gate.canIssue !== canIssue || gate.status !== (canIssue ? 'ready' : 'blocked')) {
      throw new ArchiveError(400, 'invalid_release_gate', '存在未接受的高风险缺陷时，快照不得标记为可签发。');
    }
    if (JSON.stringify(gate.blockingDefects ?? []) !== JSON.stringify(blockingDefects)) {
      throw new ArchiveError(400, 'invalid_release_gate', '签发门禁的阻断缺陷列表与缺陷复核状态不一致。');
    }
  }

  private toSummary(archive: ArchivedReport): ArchiveSummary {
    const highRiskCount = archive.defects.filter(isHighRisk).length;
    return {
      archiveId: archive.archiveId,
      idempotencyKey: archive.idempotencyKey,
      createdAt: archive.createdAt,
      archiveStatus: archive.releaseGate.canIssue ? 'release_ready' : 'pending_review',
      canIssue: archive.releaseGate.canIssue,
      scanId: text(archive.scan.id),
      part: text(archive.scan.part),
      lot: text(archive.scan.lot),
      defectCount: archive.defects.length,
      highRiskCount,
      blockingDefectCount: archive.releaseGate.blockingDefects.length,
      contentHash: archive.contentHash,
    };
  }
}
