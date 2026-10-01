# 工业 CT 无损检测工作台

React + Vite + TypeScript 前端与 Fastify + TypeScript API 的全栈工业 CT 阅片、标注和复核演示项目。

## 功能
- 轴向、冠状、矢状三正交切片联动阅片
- 可调窗宽、窗位与切片序号
- 孔隙、裂纹、夹杂和未熔合缺陷标注
- API 持久于进程内的标注流、删除、汇总报告
- 缺陷尺寸、严重度、复核意见和检测摘要
- 独立「报告归档」模块：签发前证据快照（见下）

## 报告归档模块（`/api/archives`）
质量负责人在签发前把 CT 证据冻结为**不可变快照**，交给后续审核；实时标注与复核继续变化不影响旧归档。

- **快照内容**：扫描信息、工作流、缺陷与复核状态、尺寸测量、炉次对比、签发门禁，一次性深拷贝组装，入库后递归冻结。
- **门禁决定状态**：任一 `severity=高` 的缺陷未被 `accepted`（含 `rejected`/未复核）时，归档只能保存为 `pending` 待处理版本，`releasable` 恒为 `false`；状态完全由服务端推导，请求体无法伪造。
- **原子提交，无补偿**：`create()` 只有 prepare（组装/哈希/查重）与 commit（一次性入栈）两阶段，prepare 失败零写入，不存在部分失败，因此无需补偿恢复。
- **幂等不重复**：支持 `Idempotency-Key` 头（并发请求合并）；刷新后 key 丢失时，还会按 `sourceFingerprint`（快照内容 + 小时时间桶）去重。
- **同一快照三入口**：列表 `GET /api/archives`、详情 `GET /api/archives/:id`、下载 `GET /api/archives/:id/download` 读取同一份冻结记录，并附 SHA-256 `contentHash`，下载文件可离线重算校验；篡改门禁等字段会导致哈希失配。

API 速览：
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/archives` | 创建归档（可带 `Idempotency-Key`），201 新建 / 200 重复回放，prepare 失败 503 可安全重试 |
| GET | `/api/archives` | 归档列表（摘要 + `verified`） |
| GET | `/api/archives/:id` | 归档详情（完整快照 + 哈希校验结果） |
| GET | `/api/archives/:id/download` | 下载快照 JSON（`X-Content-Hash`/`X-Content-Verified` 头） |

## 启动
```bash
npm install
npm run dev
```
网页：`http://localhost:5182`；API：`http://localhost:6182`。

## 测试
```bash
npm test -w @lab/api
```
端到端覆盖：快照不可变（归档后增删改实时数据）、高风险未接受只能待处理、状态伪造被忽略、幂等键串行/并发去重、刷新恢复内容去重、注入故障零部分写入后重试、列表/详情/下载哈希互证、下载文件篡改失配、驳回同样阻断。
