# 工业 CT 无损检测工作台

React + Vite + TypeScript 前端与 Fastify + TypeScript API 的全栈工业 CT 阅片、标注和复核演示项目。

## 功能
- 轴向、冠状、矢状三正交切片联动阅片
- 可调窗宽、窗位与切片序号
- 孔隙、裂纹、夹杂和未熔合缺陷标注
- API 持久于进程内的标注流、删除、汇总报告
- 缺陷尺寸、严重度、复核意见和检测摘要
- 独立报告归档 API：扫描信息、工作流、缺陷复核、尺寸测量、炉次对比和签发门禁生成不可变快照
- 幂等归档提交、待处理/可签发状态、列表、详情和 JSON 下载

## 报告归档 API
- `POST /api/report-archives`：必须携带 `Idempotency-Key` 请求头（或 body 中的 `idempotencyKey`）。服务端先完整组装并校验快照，再原子提交；组装失败不会留下记录，重复提交返回同一份归档。
- 归档状态：`release_ready` 表示可签发；存在未被 `accepted` 接受的高风险缺陷时只能保存为 `pending_review`，门禁保持 `blocked`。
- `GET /api/report-archives`：归档摘要列表，字段由冻结快照生成。
- `GET /api/report-archives/:archiveId`：读取完整快照。
- `GET /api/report-archives/:archiveId/download`：下载同一份快照 JSON，响应头包含 `X-Archive-Content-Hash`。
- `GET /api/report-archives/by-idempotency-key?idempotencyKey=...`：客户端刷新或网络超时后恢复创建结果；404 表示此前提交未完成。

归档快照在创建时深拷贝实时数据并递归冻结，后续标注、删除和复核变化不会影响旧归档。

## 启动
```bash
npm install
npm run dev
```
网页：`http://localhost:5182`；API：`http://localhost:6182`。
