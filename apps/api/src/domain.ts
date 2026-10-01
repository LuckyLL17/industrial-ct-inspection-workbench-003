// 领域层：实时检测数据（可变）与归档快照组装（不可变）。
// 归档快照是组装时刻的纯数据深拷贝：组装之后实时标注/复核的任何变化
// 都不会回溯影响快照，快照写入后也不允许回写实时数据。

export type ReviewStatus = 'unreviewed' | 'in_review' | 'accepted' | 'rejected';

export type Annotation = {
  id: string;
  axis: string;
  index: number;
  x: number;
  y: number;
  kind: string;
  severity: string;
  note: string;
  diameter: number;
  confidence: number;
  reviewStatus: ReviewStatus;
  reviewer?: string;
  createdAt: string;
};

export type WorkflowStep = { id: string; label: string; status: string; owner: string; detail: string };

export type Scan = {
  id: string;
  part: string;
  material: string;
  resolution: string;
  dimensions: string;
  operator: string;
  acquiredAt: string;
  scanner: string;
  lot: string;
  standard: string;
};

export const scan: Scan = {
  id: 'valve-housing-017',
  part: '液压阀体 / VH-017',
  material: 'AlSi10Mg',
  resolution: '42 μm',
  dimensions: '128 × 128 × 96 voxels',
  operator: '张工',
  acquiredAt: '2026-09-30 08:42',
  scanner: 'Phoenix v|tome|x M 300',
  lot: 'LOT-2026-09-A17',
  standard: 'ASTM E1441'
};

export let annotations: Annotation[] = [
  { id: 'D-024', axis: 'axial', index: 42, x: 57, y: 39, kind: '孔隙', severity: '中', note: '疑似缩孔，建议复核', diameter: 1.86, confidence: .91, reviewStatus: 'in_review', reviewer: '王工', createdAt: '2026-09-30T09:12:00.000Z' },
  { id: 'D-031', axis: 'coronal', index: 37, x: 31, y: 61, kind: '夹杂', severity: '低', note: '边缘夹杂', diameter: .72, confidence: .74, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:18:00.000Z' },
  { id: 'D-044', axis: 'sagittal', index: 51, x: 64, y: 47, kind: '裂纹', severity: '高', note: '线性高密度异常，需二次扫描确认', diameter: 3.42, confidence: .68, reviewStatus: 'unreviewed', createdAt: '2026-09-30T09:27:00.000Z' }
];

export function setAnnotations(next: Annotation[]): void {
  annotations = next;
}

export const workflow: WorkflowStep[] = [
  { id: 'ingest', label: '数据接收', status: 'done', owner: '系统', detail: '原始 DICOM 序列已校验' },
  { id: 'reconstruct', label: '体数据重建', status: 'done', owner: '算法服务', detail: '96 层切片已生成' },
  { id: 'primary', label: '初检标注', status: 'active', owner: '张工', detail: '存在 3 个候选缺陷' },
  { id: 'review', label: '二次复核', status: 'pending', owner: '王工', detail: '等待高风险裂纹复核' },
  { id: 'release', label: '报告签发', status: 'pending', owner: '质量负责人', detail: '需完成复核与判定' }
];

export function stats() {
  return {
    defectCount: annotations.length,
    criticalCount: annotations.filter(item => item.severity === '高').length,
    unreviewedCount: annotations.filter(item => item.reviewStatus !== 'accepted' && item.reviewStatus !== 'rejected').length,
    totalVolume: +annotations.reduce((sum, item) => sum + 4 / 3 * Math.PI * (item.diameter / 2) ** 3, 0).toFixed(2),
    byKind: Object.entries(annotations.reduce<Record<string, number>>((out, item) => {
      out[item.kind] = (out[item.kind] ?? 0) + 1;
      return out;
    }, {})).map(([kind, count]) => ({ kind, count }))
  };
}

export function measurements() {
  return annotations.map(item => ({
    annotationId: item.id,
    diameter: item.diameter,
    estimatedVolume: +(4 / 3 * Math.PI * (item.diameter / 2) ** 3).toFixed(2),
    aspectRatio: +(1.1 + item.diameter * .24).toFixed(2),
    tolerance: item.diameter > 2 ? '超出工艺关注阈值' : '在监控范围内'
  }));
}

export function batchComparison() {
  const previous = { scanId: 'valve-housing-016', label: 'VH-016 / 上一炉次', defectCount: 2, highRisk: 0 };
  const current = {
    scanId: scan.id,
    label: 'VH-017 / 本次扫描',
    defectCount: annotations.length,
    highRisk: annotations.filter(item => item.severity === '高').length
  };
  return {
    current,
    previous,
    delta: { defectCount: current.defectCount - previous.defectCount, highRisk: current.highRisk - previous.highRisk }
  };
}

// 签发门禁完全由快照内容推导：只要存在 severity=高 且复核结论不是 accepted
// 的缺陷，门禁即为 blocked。客户端无法在请求中指定/覆盖该结论。
export type ReleaseGate = {
  status: 'ready' | 'blocked';
  blockingDefects: Array<{ id: string; kind: string; severity: string; reviewStatus: ReviewStatus; reason: string }>;
  rule: string;
};

export function buildReleaseGate(defects: Annotation[] = annotations): ReleaseGate {
  const blockingDefects = defects
    .filter(item => item.severity === '高' && item.reviewStatus !== 'accepted')
    .map(item => ({
      id: item.id,
      kind: item.kind,
      severity: item.severity,
      reviewStatus: item.reviewStatus,
      reason: item.reviewStatus === 'rejected'
        ? '高风险缺陷已被驳回，不能放行'
        : '高风险缺陷未被接受（尚未复核或仍在复核中）'
    }));
  return {
    status: blockingDefects.length === 0 ? 'ready' : 'blocked',
    blockingDefects,
    rule: '任一 severity=高 的缺陷必须复核结论为 accepted，报告方可签发'
  };
}

// —— 归档快照 ——

export const SNAPSHOT_SCHEMA_VERSION = '1.0';

export type ArchiveSnapshot = {
  schemaVersion: string;
  scan: Scan;
  workflow: WorkflowStep[];
  defects: Annotation[];
  reviewState: ReturnType<typeof stats>;
  measurements: ReturnType<typeof measurements>;
  batchComparison: ReturnType<typeof batchComparison>;
  releaseGate: ReleaseGate;
  capturedAt: string;
};

// 深拷贝纯 JSON 数据，切断与实时数组/对象的全部引用共享。
export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

// 在组装时刻一次性读取各实时数据源并冻结成快照。
// 所有片段都经过深拷贝：快照里的 defects 与实时 annotations 不再是同一批对象。
export function assembleSnapshot(now: string = new Date().toISOString()): ArchiveSnapshot {
  const defects = deepClone(annotations);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    scan: deepClone(scan),
    workflow: deepClone(workflow),
    defects,
    reviewState: stats(),
    measurements: measurements(),
    batchComparison: batchComparison(),
    // 门禁基于快照内的缺陷副本推导，保证与快照其余部分自洽
    releaseGate: buildReleaseGate(defects),
    capturedAt: now
  };
}
