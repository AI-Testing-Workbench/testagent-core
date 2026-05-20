# Testagent Routes - 快速参考

## 🎯 新增的 7 个端点

### Testagent 用户管理
```http
PUT /kilocode/testagent/user
Content-Type: application/json

{
  "id": "user-id",
  "name": "User Name",
  "token": "auth-token"  // 可选
}
```

### Instance 路由
```http
# 重新加载技能
POST /skill/reload

# 重新加载 MCP 服务器
POST /mcp/reload

# 增强提示词
POST /enhance-prompt
Content-Type: application/json

{
  "text": "your draft prompt here"
}
```

### Worktree Diff
```http
# 获取完整 diff
GET /experimental/worktree/diff?base=origin/main

# 获取 diff 摘要
GET /experimental/worktree/diff/summary?base=origin/main

# 获取单个文件 diff
GET /experimental/worktree/diff/file?base=origin/main&file=path/to/file.ts
```

## 📁 关键文件位置

### 新增
- `packages/opencode/src/server/routes/instance/httpapi/groups/testagent.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/testagent.ts`

### 修改
- `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts`

## 🔧 关键修复

**WorktreeDiff Service 注册**
```typescript
// server.ts
import { WorktreeDiff } from "@/testagent/review/worktree-diff"

// 在 createRoutes 的 Layer.provide 中添加
WorktreeDiff.defaultLayer,
```

## ✅ 验证命令

```bash
# 类型检查
cd packages/opencode && bun typecheck

# 启动服务器
bun run packages/opencode/bin/opencode serve

# 测试端点
curl -X PUT http://localhost:4096/kilocode/testagent/user \
  -H "Content-Type: application/json" \
  -d '{"id":"test","name":"Test"}'
```

## 📚 完整文档

1. `TESTAGENT_ROUTES_IMPLEMENTATION.md` - 完整实现文档
2. `IMPLEMENTATION_CHECKLIST.md` - 实现清单
3. `WORKTREE_DIFF_FIX.md` - 服务修复说明
4. `FINAL_STATUS.md` - 最终状态报告
5. `QUICK_REFERENCE.md` - 本文档

## 🎉 状态

✅ **所有工作已完成！**
