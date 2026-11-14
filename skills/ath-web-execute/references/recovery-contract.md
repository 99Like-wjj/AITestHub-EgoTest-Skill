# 恢复与交付契约

0.2.1固定已发布ae7aca39快照，来源和派生hash见 `contracts/v2-provenance.json`；JSON Schema只作结构检查，服务端当前角色/CAS/refine仍权威。旧0.1.0的v1语义及unknown journal用保留的原包恢复，不复制进新前缀，也不根据服务器数量补造丢失的动作/观察。

| 操作            | 原身份与只读恢复                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claim           | 固定localExecutionId/source/provenance；原 `ath_operation_status get {operation:ui-executions.claim.<sourceRevisionId>,key:原localExecutionId}`，不新建run规避 |
| get-scope       | 只读原范围，不等于实际执行resume，不启动浏览器、不升级版本                                                                                                     |
| batch           | 固定batchId和全部JSON/摘要，`ath_results/ui-batch-receipt`读原批次；404仍unknown，不新key覆盖已收项                                                            |
| end/resume/seal | 固定commandId、原CAS及前事实/ledger，按 `ui-executions.declare-end`、`ui-executions.declare-resume`、`results.ui-delivery.seal`查原operation/key；无确认不重发 |
| progress        | 原sequence/值/时间持续保存；v2 status只给真实watermark，不证明原summary/payload已经确认。观察到已占序号可明确准备新的当前进度，不重发旧未知写或从scope猜号     |
| files           | 先持久原fileId/localFileId再完整PUT；未知读原身份，verified证明字节而非业务；不重新截图或重做SUT来修复上传                                                     |

未知恢复只查询。只有已知notDispatched/knownFailed的元数据事务可经明确原因准备原payload重试，unknown不适用；这也不授予任何SUT创建/付款/删除等动作重放权限。401/403/安全404先核当前权限，不能自动换账号或Key续写。

v2的claim也遵守此门禁：unknown/dispatched即使给`replayReason`或原查询404仍拒绝再次claim；只读查到真实原receipt后恢复同run。只有可信端口本次已记录knownFailed/notDispatched、且本地为rejected时，非空原因才允许原身份重试。旧rejected记录缺少该证明时不推定可重试，模型参数不能补写certainty。

批次ACK核run/scope/batch/semanticDigest、完整逐项身份和真实accepted计数；pendingAssembly/conflict/rejected不伪装整批成功。单批100 involved evidence身份、唯一UUID1GiB（含原JSON），每文件100MiB；单Case1GiB/1000 refs，原JSON16MiB。101 refs通过descriptor和位置片段累计，不丢图、改字节或换计划。refs片段不是文件字节断点续传。

结束、恢复事实与交付seal分开。提前结束不自动生成未执行；显式notExecuted须真实未尝试、无after观察/未知动作、notApplicable和非空原因。修复后的重新验证使用新retest轮，原始与人工/缺陷状态独立。

seal固定全部已核对批次及当前ledger/end；它不表示文件全可读或业务全通过。补文件后看动态status，原receipt缺件列表可能过时，不修改原判断或旧结束事实。多页status必须同水位、无重复对象/游标，否则只保留部分观察并明确未完整。

本地journal损坏/孤立准备保留原字节并停止，不自动“修复”缺失事实。工具不自建HTML报告；最终展示使用可信平台origin的受权报告链接。当前候选的真实MCP/Ego/原生安装状态以验证文档为准，包完整性不代替联通。
