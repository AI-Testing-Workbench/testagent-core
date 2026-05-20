# Testagent Routes Implementation Checklist

## ✅ 已完成的工作

### 1. Testagent 用户管理路由
- [x] 创建 `groups/testagent.ts` - API 定义
- [x] 创建 `handlers/testagent.ts` - 实现逻辑
- [x] 在 `api.ts` 中导入并添加到 `RootHttpApi`
- [x] 在 `server.ts` 中导入并提供 handler
- [x] 端点: `PUT /kilocode/testagent/user`

### 2. Instance 路由扩展
- [x] 更新 `groups/instance.ts` 添加新端点定义
  - [x] `POST /skill/reload`
  - [x] `POST /mcp/reload`
  - [x] `POST /enhance-prompt`
- [x] 更新 `handlers/instance.ts` 添加实现
  - [x] `skillReload` handler
  - [x] `mcpReload` handler
  - [x] `enhancePrompt` handler
- [x] 导入必要的依赖 (MCP.Service, EnhancePromptPayload)

### 3. Experimental Worktree Diff 路由
- [x] 更新 `groups/experimental.ts` 添加新端点定义
  - [x] `GET /experimental/worktree/diff`
  - [x] `GET /experimental/worktree/diff/summary`
  - [x] `GET /experimental/worktree/diff/file`
- [x] 更新 `handlers/experimental.ts` 添加实现
  - [x] `getWorktreeDiff` handler
  - [x] `getWorktreeDiffSummary` handler
  - [x] `getWorktreeDiffFile` handler
- [x] 导入必要的依赖 (WorktreeDiff.Service, Snapshot)

### 4. 清理工作
- [x] 删除旧的 Hono 版本 `routes/testagent.ts`
- [x] 修复所有 TypeScript 类型错误
- [x] 确保所有 Schema 定义正确

## 📋 验证清单

### 代码质量
- [x] 所有新代码通过 TypeScript 类型检查
- [x] 遵循项目的代码风格指南
- [x] 使用 Effect Schema 进行类型安全验证
- [x] 所有 handler 使用 Effect.fn 包装

### API 一致性
- [x] 端点路径与旧实现保持一致
- [x] 请求/响应格式保持兼容
- [x] 操作 ID (operationId) 保持一致
- [x] 所有端点都有适当的描述和摘要

### 架构集成
- [x] 正确使用中间件 (Authorization, InstanceContext, WorkspaceRouting)
- [x] Handler 正确注册到对应的 API group
- [x] API group 正确添加到 HttpApi
- [x] Server 层正确提供所有 handler

## 📊 统计信息

### 新增文件
- 2 个新文件 (testagent group + handler)

### 修改文件
- 6 个文件被修改
  - `api.ts`
  - `server.ts`
  - `groups/instance.ts`
  - `handlers/instance.ts`
  - `groups/experimental.ts`
  - `handlers/experimental.ts`

### 删除文件
- 1 个旧文件 (routes/testagent.ts)

### 新增端点
- 7 个新端点
  - 1 个 testagent 端点
  - 3 个 instance 端点
  - 3 个 experimental 端点

## 🧪 测试建议

### 手动测试
```bash
# 启动服务器
bun run packages/opencode/bin/opencode serve

# 测试 testagent 用户设置
curl -X PUT http://localhost:4096/kilocode/testagent/user \
  -H "Content-Type: application/json" \
  -d '{"id":"test-user","name":"Test User","token":"test-token"}'

# 测试 skill 重载
curl -X POST http://localhost:4096/skill/reload

# 测试 MCP 重载
curl -X POST http://localhost:4096/mcp/reload

# 测试提示词增强
curl -X POST http://localhost:4096/enhance-prompt \
  -H "Content-Type: application/json" \
  -d '{"text":"make a function"}'

# 测试 worktree diff
curl "http://localhost:4096/experimental/worktree/diff?base=origin/main"

# 测试 worktree diff summary
curl "http://localhost:4096/experimental/worktree/diff/summary?base=origin/main"

# 测试 worktree diff file
curl "http://localhost:4096/experimental/worktree/diff/file?base=origin/main&file=README.md"
```

### 集成测试
建议创建以下测试文件：
- `test/server/httpapi-testagent.test.ts` - 测试 testagent 端点
- `test/server/httpapi-instance-extended.test.ts` - 测试新的 instance 端点
- `test/server/httpapi-worktree-diff.test.ts` - 测试 worktree diff 端点

## 📝 文档

### OpenAPI 文档
所有端点都会自动包含在 OpenAPI 文档中，可通过以下方式访问：
- HTTP: `GET http://localhost:4096/doc`
- 代码: `OpenApi.fromApi(PublicApi)`

### SDK 生成
更新 JavaScript SDK：
```bash
./packages/sdk/js/script/build.ts
```

## ✨ 完成状态

**状态: ✅ 完成**

所有带有 `testagent_change` 标识的端点已成功从旧的 Hono 架构迁移到新的 Effect HttpApi 架构。

- ✅ 代码实现完成
- ✅ 类型检查通过
- ✅ 架构集成完成
- ✅ 文档已创建

## 🚀 下一步

1. 运行完整的测试套件
2. 更新 SDK
3. 部署到测试环境验证
4. 更新相关文档
