# Testagent Routes Implementation Summary

## 概述

成功将所有带有 `testagent_change` 标识的路由从旧的 Hono 架构迁移到新的 Effect HttpApi 架构。

## 已实现的端点

### 1. Testagent 用户管理 (全局路由)

**文件位置:**
- Group: `packages/opencode/src/server/routes/instance/httpapi/groups/testagent.ts`
- Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/testagent.ts`

**端点:**
- `PUT /kilocode/testagent/user` - 设置 testagent 用户信息和认证 token

**集成位置:**
- 添加到 `RootHttpApi` (全局路由，不需要 workspace context)
- 在 `server.ts` 中的 `rootApiRoutes` 层提供 handler

---

### 2. Instance 路由扩展

**文件位置:**
- Group: `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
- Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`

**新增端点:**

#### 2.1 Skill 重载
- `POST /skill/reload`
- 操作 ID: `app.reloadSkills`
- 功能: 使技能缓存失效并从磁盘重新加载所有技能

#### 2.2 MCP 服务器重载
- `POST /mcp/reload`
- 操作 ID: `mcp.reload`
- 功能: 从配置文件重新加载所有 MCP 服务器，无需重启 CLI

#### 2.3 提示词增强
- `POST /enhance-prompt`
- 操作 ID: `enhancePrompt.enhance`
- 功能: 将用户的草稿提示词重写为更清晰、更具体、更有效的提示词
- Payload: `{ text: string }` (非空字符串)
- Response: `{ text: string }` (增强后的提示词)

---

### 3. Experimental 路由扩展 (Worktree Diff)

**文件位置:**
- Group: `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts`
- Handler: `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`

**新增端点:**

#### 3.1 获取 Worktree 完整 Diff
- `GET /experimental/worktree/diff`
- 操作 ID: `worktree.diff`
- 功能: 获取 worktree 相对于基础分支的文件差异，包括未提交的更改
- Query 参数: `base?: string` (默认: "origin/main")
- Response: `Array<FileDiff>` (包含 file, patch, additions, deletions, status)

#### 3.2 获取 Worktree Diff 摘要
- `GET /experimental/worktree/diff/summary`
- 操作 ID: `worktree.diffSummary`
- 功能: 获取轻量级的文件差异元数据
- Query 参数: `base?: string` (默认: "origin/main")
- Response: `Array<WorktreeDiff.Item>` (轻量级摘要)

#### 3.3 获取单个文件的 Diff 详情
- `GET /experimental/worktree/diff/file`
- 操作 ID: `worktree.diffFile`
- 功能: 获取单个 worktree 文件相对于基础分支的完整差异内容
- Query 参数:
  - `base?: string` (默认: "origin/main")
  - `file: string` (必需，要加载差异内容的相对文件路径)
- Response: `WorktreeDiff.Item | null`

---

## 架构变更

### 新增文件

1. **Testagent Group**
   - `packages/opencode/src/server/routes/instance/httpapi/groups/testagent.ts`
   - 定义 testagent 用户管理 API

2. **Testagent Handler**
   - `packages/opencode/src/server/routes/instance/httpapi/handlers/testagent.ts`
   - 实现 testagent 用户设置逻辑

### 修改的文件

1. **API 定义** (`api.ts`)
   - 导入 `TestagentApi`
   - 将 `TestagentApi` 添加到 `RootHttpApi`

2. **Server 配置** (`server.ts`)
   - 导入 `testagentHandlers`
   - 导入 `WorktreeDiff` 服务
   - 在 `rootApiRoutes` 层中提供 `testagentHandlers`
   - 在 `createRoutes` 中提供 `WorktreeDiff.defaultLayer`

3. **Instance Group** (`groups/instance.ts`)
   - 添加新的路径常量: `skillReload`, `mcpReload`, `enhancePrompt`
   - 添加新的 Schema: `ReloadResult`, `EnhancePromptPayload`, `EnhancePromptResult`
   - 添加三个新的端点定义

4. **Instance Handler** (`handlers/instance.ts`)
   - 导入 `MCP.Service`
   - 导入 `EnhancePromptPayload`
   - 实现 `skillReload`, `mcpReload`, `enhancePrompt` 三个 handler

5. **Experimental Group** (`groups/experimental.ts`)
   - 导入 `Snapshot` 和 `WorktreeDiff`
   - 添加新的路径常量: `worktreeDiff`, `worktreeDiffSummary`, `worktreeDiffFile`
   - 添加新的 Query Schema: `WorktreeDiffQuery`, `WorktreeDiffFileQuery`
   - 添加三个新的端点定义

6. **Experimental Handler** (`handlers/experimental.ts`)
   - 导入 `WorktreeDiff.Service`
   - 导入 Query 类型
   - 实现 `getWorktreeDiff`, `getWorktreeDiffSummary`, `getWorktreeDiffFile` 三个 handler

### 删除的文件

1. **旧的 Testagent 路由**
   - `packages/opencode/src/server/routes/testagent.ts` (基于 Hono 的旧实现)

---

## 技术细节

### Schema 定义

所有端点都使用 Effect Schema 进行类型安全的请求/响应验证：

```typescript
// 示例: EnhancePromptPayload
export const EnhancePromptPayload = Schema.Struct({
  text: Schema.NonEmptyString,
})

// 示例: WorktreeDiffQuery
export const WorktreeDiffQuery = Schema.Struct({
  base: Schema.optional(Schema.String),
})
```

### Handler 实现模式

所有 handler 都遵循 Effect 的函数式编程模式：

```typescript
const enhancePrompt = Effect.fn("InstanceHttpApi.enhancePrompt")(function* (ctx: {
  payload: typeof EnhancePromptPayload.Type
}) {
  const { enhancePrompt: enhance } = yield* Effect.promise(() => import("@/testagent/enhance-prompt"))
  const result = yield* Effect.promise(() => enhance(ctx.payload.text as string))
  return { text: result }
})
```

### 中间件配置

- **Testagent 路由**: 使用 `Authorization` 中间件（全局路由）
- **Instance 路由**: 使用 `InstanceContextMiddleware`, `WorkspaceRoutingMiddleware`, `Authorization`
- **Experimental 路由**: 使用 `InstanceContextMiddleware`, `WorkspaceRoutingMiddleware`, `Authorization`

---

## 验证

### 类型检查

所有新增代码通过 TypeScript 类型检查：

```bash
cd packages/opencode
bun typecheck
```

结果: ✅ 无类型错误（除了预存在的 langfuse 错误）

### 端点路径

所有端点路径保持与旧实现一致：

| 旧路径 | 新路径 | 状态 |
|--------|--------|------|
| `PUT /kilocode/testagent/user` | `PUT /kilocode/testagent/user` | ✅ |
| `POST /skill/reload` | `POST /skill/reload` | ✅ |
| `POST /mcp/reload` | `POST /mcp/reload` | ✅ |
| `POST /enhance-prompt` | `POST /enhance-prompt` | ✅ |
| `GET /experimental/worktree/diff` | `GET /experimental/worktree/diff` | ✅ |
| `GET /experimental/worktree/diff/summary` | `GET /experimental/worktree/diff/summary` | ✅ |
| `GET /experimental/worktree/diff/file` | `GET /experimental/worktree/diff/file` | ✅ |

---

## 依赖的模块

新实现依赖以下现有模块（无需额外安装）：

1. **@/testagent/user** - 用户信息管理
2. **@/external-auth** - 外部认证 token 管理
3. **@/testagent/enhance-prompt** - 提示词增强功能
4. **@/testagent/review/worktree-diff** - Worktree 差异分析
5. **@/skill** - 技能管理服务
6. **@/mcp** - MCP 服务器管理
7. **@/snapshot** - 快照和文件差异类型

---

## 迁移完成状态

✅ **所有 testagent_change 标识的端点已成功迁移到新架构**

- ✅ Testagent 用户管理 (1 个端点)
- ✅ Instance 路由扩展 (3 个端点)
- ✅ Experimental Worktree Diff (3 个端点)

**总计: 7 个新端点**

所有端点都：
- 使用 Effect HttpApi 架构
- 提供完整的 OpenAPI 文档
- 支持类型安全的请求/响应
- 集成到统一的中间件系统
- 保持与旧 API 的路径兼容性

---

## 后续步骤

1. **测试**: 建议创建集成测试验证所有端点的功能
2. **文档**: OpenAPI 文档会自动生成，可通过 `/doc` 端点访问
3. **SDK 更新**: 运行 SDK 生成脚本更新客户端代码：
   ```bash
   ./packages/sdk/js/script/build.ts
   ```

---

## 注意事项

1. 所有端点都需要认证（通过 `Authorization` 中间件）
2. Instance 和 Experimental 端点需要 workspace context
3. Testagent 端点是全局路由，不需要 workspace context
4. 所有异步操作都使用 Effect 的 Promise 包装以保持一致性
