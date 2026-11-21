# v2数据交付与明确结束

先使用可信host调用 `runV2LocalCommand`，注入已认证principal、官方MCP端口、私有Workspace/FileChannel及privateRoot。request不能指定网络、Key或根目录。当前固定契约ae7aca39，读取时仍须核平台可用能力；0.1.0旧journal用原冻结包恢复，不复制、清空、改标识迁移到v2。

`claim-prepare`先落原身份和请求，`claim-dispatch`领取固定scope；丢ACK用`claim-recover`只查原operation/key。`freeze`仅固定已取得scope，不表示执行或业务通过。v2本地路径为私有根下`v2/runs/<runId>`，检测到同身份旧路径就停止。按需`read-case`，当前AI决定现场路径并通过Ego真实观察；每次`begin-action`先记意图，`action-status`保留实际attempted事实，`observe`/`index-evidence`/`record-result`保存原判断。不得用notExecuted隐藏未知或已观察动作。

unknown/dispatched claim不能因`replayReason`、当前404或同key幂等而再写；原receipt找到前保持只读。只有可信端口已记录的knownFailed/notDispatched，才可显式原因重试同一claim身份，不根据模型自述或旧rejected标签补造证明。

文件用`upload-evidence`沿原localEvidenceId/完整字节，未知先`recover-file`，不得重做页面来“修复上传”。完整PUT不是断点续传。单文件100MiB、单结果1GiB/1000引用；超限保原件/缺口，不丢图、改bytes或编原fileId。

`record-result.input.item` 可带 `stepObservations`，每项包含冻结步骤从 1 开始的 `ordinal`、可复现的实际观察 `actual`、可选 `outcome` 和 `evidenceRefs`。步骤证据使用同一结果已登记的 `localEvidenceId`，也列入结果自己的 `evidenceRefs`。同一阶段有多条观察时，原始事实保存在 `observe` 记录，结果内按冻结步骤汇总为一项。上传前核对证据公开范围，按实际观察填写，不补造位置、时间或判断。

缺证在 `item.evidenceGaps` 写明名称 `label`、`state` 和 `reason`，可用 `ordinal` 定位冻结步骤。`notCaptured` 表示没有采集，`pendingUpload` 表示真实文件已保留但还未交付，`uploadFailed` 表示已确认传输失败。上传结果未知时先查原回执。整项缺口可省略步骤序号。选择证据上报时保留原字节和真实引用，仍按本节文件规则核验。新结构随内联批次、原批 JSON 和 descriptor 核心一同交付，使用具备步骤证据契约的平台和可信宿主客户端。

`prepare-delivery`只处理已记录且未进入其他plan的原结果，或显式选择runItemIds。确定性分批器按100 involved证据身份/唯一resource UUID字节/原JSON预算分组，同run可累计多批。一个Case超过100引用用冻结descriptor与refs片段，不把文件切字节；fullRefsDigest/itemDigest/位置沿原顺序，所有图保留。

每批可以 `export-batch-json`→`upload-evidence`→`attach-batch-json`，核完整源JSON后只发送fileId；大于MCP帧的批次必须使用此通道。源JSON也计入单批1GiB，最大16MiB。`v2-preflight`只是只读预检；`v2-dispatch`先写dispatching再发一次。看逐项accepted/skipped/pendingAssembly/conflict/rejected，不把ACK或reportId当全成。已发/未知批次不得换batchId或整批新plan覆盖，`v2-recover`只查原batch；404仍unknown。

真正结束时当前AI明确 `prepare-end`（normal/terminated/interrupted、实际endedAt及原因），再显式dispatch。normal需本地完整交代固定scope；提前结束不自动生成未执行事实。需要明确未执行时 `record-not-executed`逐项带原因，仍检查本地动作/观察与远端已报告事实。结束只登记，不停止/遥控Ego。

恢复同run新执行段用 `prepare-resume`，绑定已核实当前end事实、resumedAt和原因；它不重跑已结果Case，不清未知动作，也不代替修复后的新复测轮。未知end/resume/seal只查原command；不据404重发。需要重新处理已知未发送/已知事务失败时，`retry-known-v2-failure`须明确原因，仅恢复原metadata请求，unknown不适用。

累计事实都已报告、无pending descriptor并已有明确end后，`prepare-seal`固定ledgerVersion/digest/endFactId，再显式dispatch。seal不改执行状态，不等于文件齐全、业务全通过或缺陷关闭；缺文件可原身份补齐后读动态状态，不再end或跑Case。

`v2-status`可按items/files/batches/descriptors/facts读元数据；allPages模式核同一水位和游标完整性，水位变化就不能把已有部分页称完整。progress用真实序号，未知progress的watermark只证明当前序号，不假称原payload已确认；不靠scope或完成数补造丢失本地账。平台负责可视化与HTML导出，本Skill只留JSON/必要追溯说明。
