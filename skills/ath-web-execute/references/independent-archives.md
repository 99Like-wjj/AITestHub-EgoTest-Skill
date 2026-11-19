# 已执行 UI 记录独立归档

整理已发生的真实本地结果。execution 按 ath.ui-archive.v1 记录本地执行标识、标题、实际环境、起止时刻、来源、各条目需求及可选的精确用例修订。results 为每个 localItemId 的实际观察及原始判断。evidence 用 localEvidenceId 和文件名映射证据 SHA-256、字节数、类型和完整性。

生产数据由当前 AI 基于原账本填写。可信 host 调用 exportUiArchive 校验并导出 Web 导入 JSON，离线可用 tool.mjs validate-archive。用真实需求、修订、原始判断和证据。待上传文件保留在原账本。

调用 runUiArchiveCommand(ports, request)。preview 传 projectId 和 source，即 execution。用户核对匹配与范围后，commit 传 projectId 与原 localExecutionId。工具用预览时已落盘的命令身份，并返回原轮次与条目映射。写已发送或未知时用 recover 查询原登记。只通过 FileChannel 上传同一 run 的原证据文件并取得 fileId，沿用原文件回执和完整字节校验。核对证据后以 submit 传 projectId、原 localExecutionId、items（results）及 files（上传回执与证据元数据组合）。结果丢 ACK 时调用 recover-submission 查同一个提交。报告和逐项回执均回读。

此交付路径使用独立归档契约及共享原始结果和文件端口。常规固定计划执行、复测继续使用原固定范围和 v2 交付入口。
