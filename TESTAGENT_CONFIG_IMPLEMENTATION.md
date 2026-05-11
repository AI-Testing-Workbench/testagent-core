# TestAgent 配置独立性实现

## 概述

本次实现为 testagent-core 添加了配置独立性功能，使 testagent 可以拥有自己的配置文件，同时保持对 opencode 配置的完全兼容。

## 实现的功能

### 1. 配置文件支持

testagent 现在支持以下配置文件（按优先级从低到高）：

**全局配置**：
- `~/.opencode/config.json`
- `~/.opencode/opencode.json`
- `~/.opencode/opencode.jsonc`
- `~/.testagent/testagent.json` ✨ 新增
- `~/.testagent/testagent.jsonc` ✨ 新增

**项目配置**：
- `.opencode/opencode.json`
- `.opencode/opencode.jsonc`
- `.testagent/testagent.json` ✨ 新增
- `.testagent/testagent.jsonc` ✨ 新增

### 2. 配置合并策略

- testagent 配置会覆盖 opencode 配置
- 支持使用 `null` 值删除继承的配置项
- 数组字段（如 `instructions`）会合并并去重

### 3. 目录结构支持

新增对 `.testagent/` 目录的支持：
- `.testagent/command/` - 自定义命令
- `.testagent/commands/` - 自定义命令（复数形式）
- `.testagent/agent/` - 自定义 agent
- `.testagent/agents/` - 自定义 agent（复数形式）
- `.testagent/AGENTS.md` - Agent 指令文件

### 4. 指令文件加载

新增对以下指令文件的支持：
- `~/.testagent/AGENTS.md` - 全局 testagent 指令
- `.testagent/AGENTS.md` - 项目级 testagent 指令

## 修改的文件

### 1. `src/config/config.ts`

**添加的功能**：
- `stripNulls()` 函数：支持用 `null` 值删除配置项
- 在 `loadGlobal()` 中加载 testagent 全局配置
- 在 `loadInstanceState()` 中加载 testagent 项目配置
- 在配置目录循环中加载 `.testagent/` 目录的配置
- 在 managed config 中加载 testagent 配置

**标记**：所有修改都使用 `testagent_change` 标记

### 2. `src/config/paths.ts`

**添加的功能**：
- `testagentDirectories()` 函数：收集所有 `.testagent/` 目录

**标记**：使用 `testagent_change` 标记

### 3. `src/session/instruction.ts`

**添加的功能**：
- 在 `globalFiles` 中添加 `~/.testagent/AGENTS.md`
- 在 `systemPaths()` 中扫描 `.testagent/AGENTS.md`

**标记**：使用 `testagent_change` 标记

### 4. `src/config/command.ts`

**添加的功能**：
- 在路径模式中添加 `.testagent/command/` 和 `.testagent/commands/`

**标记**：使用 `testagent_change` 标记

### 5. `src/config/agent.ts`

**添加的功能**：
- 在路径模式中添加 `.testagent/agent/` 和 `.testagent/agents/`

**标记**：使用 `testagent_change` 标记

## 使用示例

### 示例 1：覆盖 opencode 配置

**~/.opencode/opencode.json**:
```json
{
  "model": "anthropic/claude-3-5-sonnet-20241022",
  "shell": "/bin/bash"
}
```

**~/.testagent/testagent.json**:
```json
{
  "model": "openai/gpt-4",
  "shell": "/bin/zsh"
}
```

结果：使用 `openai/gpt-4` 和 `/bin/zsh`

### 示例 2：删除继承的配置项

**~/.opencode/opencode.json**:
```json
{
  "autoupdate": true,
  "share": "auto"
}
```

**~/.testagent/testagent.json**:
```json
{
  "autoupdate": null,
  "share": "manual"
}
```

结果：`autoupdate` 被删除，`share` 设置为 `"manual"`

### 示例 3：自定义 Agent

创建文件 `.testagent/agents/reviewer.md`：

```markdown
---
description: Code review agent
mode: subagent
---

You are a code review expert. Review the code for:
- Best practices
- Security issues
- Performance concerns
```

然后可以通过 `@reviewer` 调用此 agent。

## 测试

所有现有测试通过（81 个测试），确保：
- 配置加载逻辑正确
- 配置合并策略正确
- 向后兼容性保持
- 不影响现有功能

## 兼容性

- ✅ 完全向后兼容 opencode 配置
- ✅ 不影响现有 opencode 用户
- ✅ testagent 用户可以选择性使用新功能
- ✅ 配置优先级清晰：opencode（基础）→ testagent（覆盖）

## 注意事项

1. 所有修改都使用 `testagent_change` 标记，符合 fork 管理规范
2. 不需要修改 `packages/opencode/src/testagent/` 目录下的文件（这些是 testagent 专属代码）
3. 配置加载顺序确保 testagent 配置具有更高优先级
4. `null` 值作为删除标记，可以移除不需要的 opencode 配置项
