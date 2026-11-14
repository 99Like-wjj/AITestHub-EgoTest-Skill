# AITestHub-EgoTest-Skill 开发约束

<!-- Public development entry; private context belongs in AGENTS.local.md. -->

规范版本：2026-11-14.1。本文件是可入库的通用 AI 协作入口，不存实例或交接历史。

## 开始修改前必须读取

1. [贡献与变更约束](CONTRIBUTING.md)。
2. [当前规范索引](docs/development/README.md)。
3. [配置与秘密](docs/development/configuration.md)、[架构与依赖](docs/development/architecture.md)、[格式与构建包](docs/development/style-and-packaging.md)。
4. [审查与交付清单](docs/development/review-checklist.md)。

本地若存在 AGENTS.local.md，还须读取其中当前业务、环境及授权边界；该私有附录不提交。用户当前指令优先，既有明确授权在其范围内有效。工程规范不改变已确认业务；历史阶段、旧命令和旧源码状态不覆盖较新明确决定。 源码分支和提交以当前 Git 为准，部署运行态以本次核对为准，不把私有附录里的旧提交当作现态。

## 不可跳过的约束

- 真实实例和秘密从代码中分离，仓库只留可移植模板；通用模块导入无真实目标或业务副作用。
- 保持职责、当前权限、稳定身份、并发基准和不可变历史；业务改变需明确依据，不能包装成格式优化。
- 严格类型和既有安全检查不得通过禁规则绕过；冻结契约和发行字节不批量格式化。
- 本地正式源与可交付源同步整改，不只修改发布副本。
- 测试目录和专用测试脚本、私有设计、证据、实例、秘密及 AGENTS.local.md 不提交；必要构建运行脚本、模板和 Skill 引用规则保留。
- 按实际变更运行 pnpm quality:check 及必要构建/本地验证；该命令不是架构、隐私或业务全验收证明。
- 开发默认 codex/ 分支，提交前审精确 diff；合并、推送、真实模型/目标和部署沿本任务明确授权，不自动恢复暂停内容。

## 项目职责

- 仅用户本地 AI 加 Ego 执行固定已批准 UI 范围；工具不代替 AI 规划或业务判断。
- 观察、动作、证据、进度、结果和交付分别记录；unknown 先查账，不重跑未知副作用。
- 恢复原 run，修复后新复测；end、resume、seal、文件齐全和业务通过分开，旧 journal 不静默迁移。
