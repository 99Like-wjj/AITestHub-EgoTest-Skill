# 本地工具与固定范围

可信宿主通过 `scripts/runtime/index.mjs` 的 `runV2LocalCommand(ports, request)` 使用当前执行入口。相邻声明文件提供注入端口类型。工作根放在仓库外，按已核实宿主身份隔离。宿主提供路径与符号链接保护、原子写和排他锁。请求 JSON 无法指定鉴权、HTTP 地址、工作根或动态适配器。

本地诊断使用 `node scripts/tool.mjs tool-info`。离线结构核验使用 `validate-scope`、`validate-batch` 或 `validate-archive`，各读取一个明确选择的 JSON 文件。原 v1 资料按对应原包核对，保留账本和回执。

| 命令 | 用途 |
| --- | --- |
| `claim-prepare` | 持久保存原 `localExecutionId` 和来源，请求尚未发送 |
| `claim-dispatch`、`claim-recover` | 领取固定范围，或查原操作。仅已知未成功的原请求可按规则显式重试 |
| `freeze`、`summary`、`read-case` | 固定已取得的范围，查看本轮和固定单项 |
| `begin-action`、`action-status`、`observe` | 记录原动作意图、发送确定性和真实观察 |
| `index-evidence`、`upload-evidence`、`recover-file` | 索引原文件，获取同一文件的登记与核验回执 |
| `verify-evidence` | 提供原有 `localEvidenceId`，核对保留文件及同一平台 `fileId` 下载内容的字节数和 SHA-256 |
| `record-result`、`record-not-executed` | 保存本项真实结论或从未执行的原因 |
| `prepare-delivery`、`v2-status` 等 | 按 [v2交付契约](v2-delivery.md) 准备原批次，查原回执及结束状态 |

已有固定范围的操作使用原 `runId`。提交本地结果时提供 `item`、`observationIds` 和 `unresolvedActionIds`。在 `item.observations` 关联业务断言、冻结步骤、实际操作与证据，在 `item.assertionResults` 给出每个必要断言的结论。在 `item.evidenceGaps` 如实记录缺口、状态和原因。观察、在途动作和证据都关联同一个固定用例。原始结论不可静默覆盖。

## 本地文件

在批准的私有根内：`claims/<hash>.json`、`runs/<runId>/state.json`、`runs/<runId>/events/<sequence>.json`。证据仅用 `evidence/...` 的相对 key，实文件位于 `runs/<runId>/evidence/...`。按所选工具实际能力保存或原样复制采集内容。读回存放在单独的 `evidence/readback/` 目录，不改变证据登记记录或原件。

每次事件先落不可变hash链，再更新原子head。缺失、篡改、截断或head更新中断后的孤立事件会保留并拒绝后续写；本版不自动修理损坏账本。恢复不足时说明限制，不能清空文件或新ID冒充原轮继续。摘要、全scope和事件哈希用于一致性，不提供密码学真实性或防本机恶意管理员保证。
