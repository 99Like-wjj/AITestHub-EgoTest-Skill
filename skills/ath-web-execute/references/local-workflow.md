# 本地工具与固定范围

**0.1.0历史接口说明。** 0.2.0新执行使用 [v2交付](v2-delivery.md) 和 `runV2LocalCommand`；旧未知journal使用保留的0.1.0完整包恢复，不用新包清空、迁移或换ID重发。

读取时机：首次执行、原run恢复或需要调用本地工具时。

## 工具与host

`scripts/runtime/index.mjs` 导出稳定入口 `runLocalCommand(ports, request)`，相邻index.d.mts提供不依赖Zod的host类型。共同可信host注入 `ToolPort / ResultPort / WorkspacePort / FileChannelPort / privateRoot / principal{actorId,platformOrigin}`；principal来自host已核身份，不来自请求。请求JSON不能指定HTTP地址、鉴权、工作根或动态adapter。host须将工作根放仓库外并按当前Actor隔离，提供路径/符号链接保护、原子写与排他锁；请求/原账本身份不符则拒绝，不将请求actorId当授权。当前host尚未随本包提供，不绕过它另写fetch、SDK或读取Key。其他JavaScript低层类用于内部诊断，不作为模型另接不受控host的入口。

本地诊断：`node scripts/tool.mjs tool-info`；结构验证：`validate-scope <已选择的JSON路径>` 或 `validate-submission <路径>`。它们不调用平台、不执行SUT，输出不回显源正文。

## 常用命令

| 命令                              | 输入核心                                                                                               | 作用                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| claim-prepare                     | identity + request{projectId,sourceType,sourceRevisionId}                                              | 持久化原localExecutionId与来源；不会领取                                                         |
| claim-dispatch / claim-recover    | 同identity/request；重传须replayReason                                                                 | 调用真实claim或只读原operation账；返回同run                                                      |
| freeze                            | identity + 原scope                                                                                     | 导入已取得scope；hash仅完整性，不证明批准/授权                                                   |
| summary / read-case               | runId；后者runItemId                                                                                   | 查看本地状态/固定单项，不重新选版                                                                |
| begin-action                      | input{runItemId,summary,sideEffect:none/possible}                                                      | 记录意图并返回actionId，不控制Ego                                                                |
| action-status                     | actionId,status,reason                                                                                 | 实际发送前标dispatched；观察后observed/unknown/notOccurred                                       |
| observe                           | input{runItemId,summary,evidenceIds,phase,observedAt?}                                                 | 记录真实before/after/reconciliation；时间不明不补造执行时间                                      |
| index-evidence                    | input{localEvidenceId,relativePath,originalName,mediaType,type,captureCompleteness,source,capturedAt?} | inspect原字节后保存hash/bytes；不证明图片语境                                                    |
| upload-evidence / recover-file    | localEvidenceId；重传须retransmissionReason                                                            | 登记身份先落盘、完整PUT、同文件恢复；不是SUT上传动作                                             |
| record-result                     | input{item,observationIds,unresolvedActionIds,evidenceGap?}                                            | AI提供业务结论，原始本地记录不可静默覆盖                                                         |
| prepare-progress                  | summary,final?                                                                                         | 每约10已执行项准备原sequence/timestamp；不自动发                                                 |
| prepare-results                   | input{completion,endedAt?,notExecutedItemIds?,allowPendingFiles?}                                      | 构造精确完整载荷/outbox；不自动补未执行或发请求                                                  |
| inspect-outbox / remote-preflight | outboxId                                                                                               | 查看冻结载荷/平台prepare预检；预检不替代提交授权                                                 |
| export-result-json                | outboxId                                                                                               | 将原冻结载荷保存为UTF-8 JSON并索引；同路径不同字节拒绝覆盖                                       |
| attach-result-json                | outboxId,localEvidenceId                                                                               | 原JSON upload-evidence verified后，在首次dispatch前固定submit-file通道；原submission/payload不变 |
| dispatch / recover                | outboxId；重传须replayReason                                                                           | 原载荷提交或只读receipt；无通用自动retry                                                         |

`runId`适用于表中除claim/freeze以外的命令。真实输入结构以包内契约快照为准。`item`沿平台resultItem字段：runItemId/localResultId/originalOutcome/actualObservations/sideEffectCertainty/evidenceRefs，可加actualActions/reason/basis/真实时间。观察与未决action必须属于该固定项；passed/failed缺关键截图须显式evidenceGap{reason,impact}。结论仍由AI负责，校验通过不是业务通过。

完整原JSON流程：prepare-results → export-result-json → upload-evidence（导出返回的localEvidenceId）→ attach-result-json → dispatch。登记/上传未知先recover-file，不能跳过verified。文件通道提交与直接body提交共用原submissionId和同一receipt语义；原JSON额外计入1GiB预算。文件提交不是D01的容量替代方案。

## 本地文件

在批准的私有根内：`claims/<hash>.json`、`runs/<runId>/state.json`、`runs/<runId>/events/<sequence>.json`。证据仅用 `evidence/...` 的相对key，实文件位于 `runs/<runId>/evidence/...`；Ego按其实际安全截图能力保存到该位置或用可信本机复制流程保留原件。不得用截图编辑/合成取代现场原件。

每次事件先落不可变hash链，再更新原子head。缺失、篡改、截断或head更新中断后的孤立事件会保留并拒绝后续写；本版不自动修理损坏账本。恢复不足时说明限制，不能清空文件或新ID冒充原轮继续。摘要、全scope和事件哈希用于一致性，不提供密码学真实性或防本机恶意管理员保证。
