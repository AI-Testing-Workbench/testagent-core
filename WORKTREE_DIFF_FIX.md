# WorktreeDiff Service 错误修复

## 问题描述

启动服务器时出现以下错误：
```
ERROR Service not found: @testagent/WorktreeDiff
```

## 根本原因

`WorktreeDiff` 服务虽然在 `experimental` handler 中被使用，但它的 layer 没有在 server.ts 的依赖注入系统中提供。

## 解决方案

### 修改的文件

**`packages/opencode/src/server/routes/instance/httpapi/server.ts`**

### 具体修改

#### 1. 添加导入

```typescript
import { WorktreeDiff } from "@/testagent/review/worktree-diff"
```

**位置**: 在其他服务导入之后，第 54 行

#### 2. 提供 Layer

在 `createRoutes` 函数的 layer 列表中添加：

```typescript
WorktreeDiff.defaultLayer,
```

**位置**: 在 `Workspace.defaultLayer` 之后，`Worktree.appLayer` 之前，第 223 行

### 完整的修改上下文

```typescript
// 导入部分
import { Vcs } from "@/project/vcs"
import { Worktree } from "@/worktree"
import { WorktreeDiff } from "@/testagent/review/worktree-diff"  // ← 新增
import { Workspace } from "@/control-plane/workspace"

// Layer 提供部分
export function createRoutes(corsOptions?: CorsOptions) {
  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, docRoute, uiRoute).pipe(
    Layer.provide([
      // ... 其他 layers ...
      Vcs.defaultLayer,
      Workspace.defaultLayer,
      WorktreeDiff.defaultLayer,  // ← 新增
      Worktree.appLayer,
      Bus.layer,
      // ... 其他 layers ...
    ]),
    // ...
  )
}
```

## 验证

### 类型检查
```bash
cd packages/opencode
bun typecheck
```

结果: ✅ 无错误

### 服务启动
启动服务器后，不应再出现 `Service not found: @testagent/WorktreeDiff` 错误。

## 技术说明

### WorktreeDiff Service 定义

`WorktreeDiff` 是一个 Effect Service，定义在：
- **文件**: `packages/opencode/src/testagent/review/worktree-diff.ts`
- **标识**: `@testagent/WorktreeDiff`
- **依赖**: `Git.Service`, `AppFileSystem.Service`

### Layer 结构

```typescript
export const layer: Layer.Layer<Service, never, Git.Service | AppFileSystem.Service>

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer)
)
```

`defaultLayer` 已经包含了所有必需的依赖，所以在 server.ts 中只需要提供 `WorktreeDiff.defaultLayer` 即可。

## 相关端点

修复此问题后，以下端点将正常工作：

1. `GET /experimental/worktree/diff` - 获取完整 diff
2. `GET /experimental/worktree/diff/summary` - 获取 diff 摘要
3. `GET /experimental/worktree/diff/file` - 获取单个文件 diff

## 状态

✅ **已修复**

- [x] 添加 WorktreeDiff 导入
- [x] 在 createRoutes 中提供 WorktreeDiff.defaultLayer
- [x] 通过类型检查
- [x] 文档已更新
