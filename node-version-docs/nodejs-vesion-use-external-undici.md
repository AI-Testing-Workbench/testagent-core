# 使用外部 Undici 解决 Node.js bodyTimeout 限制

## 需求背景

### 问题描述

在 testagent-core 的 Node.js 版本（VS Code 扩展）中，使用 LLM 进行长时间推理时（如 thinking/reasoning），会在 **5 分钟后**出现连接中断错误：

```
TypeError: terminated
Connection reset by server
```

### 问题原因

Node.js 内置的 `undici` 库（fetch 实现）有一个硬编码的 **bodyTimeout: 300 秒（5 分钟）**限制：

- 该限制在 C++ 层实现，无法通过 JavaScript 配置
- `globalThis.fetch` 直接使用内置 undici，无法修改配置
- 环境变量（如 `UNDICI_BODY_TIMEOUT`）不起作用
- 无法通过 `setGlobalDispatcher` 影响 `globalThis.fetch`

### 影响范围

- ✅ **仅影响 Node.js 环境**（VS Code 扩展）
- ❌ **不影响 Bun 环境**（CLI 版本）
  - Bun 使用原生 Zig 实现的 fetch
  - 没有 bodyTimeout 限制

## 解决方案

### 核心思路

使用**外部 undici 包**（通过 npm/bun 安装）替代内置 undici：

1. 导入外部 undici 包
2. 创建自定义 Agent，配置 `bodyTimeout: 0`
3. 使用 `setGlobalDispatcher` 设置全局 dispatcher
4. 使用 `undici.fetch` 替代 `globalThis.fetch`

### 关键发现

通过深入研究发现：

- ✅ 外部 undici 包**可以**被导入和配置
- ✅ `undici.fetch` **会**使用自定义 Agent
- ❌ `globalThis.fetch` **不会**受 `setGlobalDispatcher` 影响
- ✅ 必须使用 `undici.fetch` 而不是 `globalThis.fetch`

## 实现细节

### 1. 依赖安装

undici 已在 `packages/testagent-core/packages/opencode/package.json` 中作为运行时依赖：

```json
{
  "dependencies": {
    "undici": "7.24.4"
  }
}
```

**无需额外安装**。

**重要说明**：
- undici 必须在 `dependencies` 而不是 `devDependencies`，因为它在运行时被动态导入
- 依赖声明在使用它的包中（`packages/testagent-core/packages/opencode`），而不是根目录
- 这符合 monorepo 的最佳实践，确保依赖关系清晰

### 2. 代码实现

**文件位置**: `packages/testagent-core/packages/opencode/src/provider/provider.ts`

**实现代码**:

```typescript
// testagent_change start - Use external undici package to bypass built-in undici bodyTimeout
// Node.js built-in undici has a hardcoded 300s bodyTimeout that cannot be disabled.
// Solution: Use external undici package which allows configuring bodyTimeout: 0
const isNodeJS = typeof process !== "undefined" && process.versions?.node
const wrappedFetch = isNodeJS ? await (async () => {
  try {
    // Try to import external undici package
    const undici = await import("undici")
    
    log.info("Using external undici package to bypass bodyTimeout", {
      providerID: model.providerID,
    })
    
    // Create custom Agent with timeouts disabled
    // Note: keepAliveTimeout and keepAliveMaxTimeout must be >= 2000ms (undici requirement)
    const agent = new undici.Agent({
      bodyTimeout: 0,              // Disable body timeout (this is the key!)
      headersTimeout: 0,           // Disable headers timeout
      keepAliveTimeout: 2000,      // Minimum allowed value (2s)
      keepAliveMaxTimeout: 6000,   // Minimum allowed value (6s)
    })
    
    // Set as global dispatcher for undici.fetch
    undici.setGlobalDispatcher(agent)
    
    log.info("Custom undici Agent configured", {
      providerID: model.providerID,
      bodyTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 2000,
      keepAliveMaxTimeout: 6000,
    })
    
    // Return undici.fetch (not globalThis.fetch)
    return undici.fetch
    
  } catch (error: any) {
    log.warn("Failed to load external undici, falling back to Node.js http/https", {
      providerID: model.providerID,
      error: error.message,
    })
    
    // Fallback: Use Node.js http/https modules
    const http = await import("http")
    const https = await import("https")
    
    return async (input: any, init?: any): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const parsedUrl = new URL(url)
      const isHttps = parsedUrl.protocol === "https:"
      const client = isHttps ? https : http
      
      return new Promise((resolve, reject) => {
        const reqOptions = {
          method: init?.method || "GET",
          headers: init?.headers || {},
          timeout: 0,
        }
        
        const req = client.request(parsedUrl, reqOptions, (res) => {
          const headers = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
          }
          
          const nodeStream = res as any
          const webStream = new ReadableStream({
            start(controller) {
              nodeStream.on("data", (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk))
              })
              nodeStream.on("end", () => controller.close())
              nodeStream.on("error", (err: Error) => controller.error(err))
            },
            cancel() {
              nodeStream.destroy()
            }
          })
          
          resolve(new Response(webStream, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers,
          }))
        })
        
        req.on("error", reject)
        
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            req.destroy()
            reject(new DOMException("Aborted", "AbortError"))
          })
        }
        
        if (init?.body) {
          if (typeof init.body === "string") {
            req.write(init.body)
          } else if (Buffer.isBuffer(init.body)) {
            req.write(init.body)
          } else if (init.body instanceof Uint8Array) {
            req.write(Buffer.from(init.body))
          }
        }
        
        req.end()
      })
    }
  }
})() : (customFetch ?? fetch)
// testagent_change end
```

### 3. 关键配置参数

```typescript
const agent = new undici.Agent({
  bodyTimeout: 0,              // ✅ 禁用 body 超时（核心配置）
  headersTimeout: 0,           // ✅ 禁用 headers 超时
  keepAliveTimeout: 2000,      // ⚠️ 最小值 2000ms（undici 要求）
  keepAliveMaxTimeout: 6000,   // ⚠️ 最小值 6000ms（undici 要求）
})
```

**注意事项**:
- `bodyTimeout: 0` 是解决问题的**核心配置**
- `keepAliveTimeout` 和 `keepAliveMaxTimeout` 有最小值限制
  - 不能设为 0，否则会报错
  - 但这不影响长时间响应，因为它们只控制连接复用

### 4. 环境检测

```typescript
const isNodeJS = typeof process !== "undefined" && process.versions?.node
```

- **Node.js 环境**: 使用外部 undici 或 http/https
- **Bun 环境**: 直接使用原生 fetch（无需 workaround）

### 5. 回退机制

如果外部 undici 导入失败，自动回退到 Node.js 原生 `http`/`https` 模块：

```typescript
try {
  // 尝试使用外部 undici
  const undici = await import("undici")
  // ...
  return undici.fetch
} catch {
  // 回退到 http/https
  return customHttpFetch()
}
```

## 验证方法

### 1. 查看日志

日志文件位置: `~/.local/share/testagent/log/<timestamp>.log`

**成功使用外部 undici**:
```
INFO service=provider providerID=mocker Using external undici package to bypass bodyTimeout
INFO service=provider providerID=mocker Custom undici Agent configured bodyTimeout=0 headersTimeout=0 keepAliveTimeout=2000 keepAliveMaxTimeout=6000
```

**回退到 http/https**:
```
WARN service=provider providerID=mocker Failed to load external undici, falling back to Node.js http/https error=...
```

### 2. 测试脚本

**测试外部 undici**:
```bash
node test-undici-external.mjs
```

**预期输出**:
```
✅ Successfully imported undici package
✅ Agent constructor found!
✅ Custom agent created with bodyTimeout disabled
✅ setGlobalDispatcher found!
✅ Global dispatcher set!
✅ undici.fetch successful!
✅ Long request started!
```

### 3. 实际测试

使用 mocker 服务器的 `thinking-hang` 模式测试：

1. 启动 mocker 服务器:
   ```bash
   cd packages/opencode-mocker
   node server.js
   # 访问 http://localhost:3100 设置为 thinking-hang 模式
   ```

2. 启动 testagent-core:
   ```bash
   cd packages/testagent-core
   bun run dev
   ```

3. 发送请求，观察是否能超过 5 分钟而不中断

## 技术原理

### 为什么内置 undici 不能配置？

```
┌─────────────────────────────────────────┐
│         Node.js C++ 层                   │
│  ┌────────────────────────────────────┐ │
│  │   内置 Undici (C++ 实现)           │ │
│  │   - bodyTimeout: 300s (硬编码)     │ │
│  │   - 无配置接口                      │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
                  ↓
         globalThis.fetch
         (无法配置)
```

### 为什么外部 undici 可以配置？

```
┌─────────────────────────────────────────┐
│      外部 Undici 包 (JavaScript)         │
│  ┌────────────────────────────────────┐ │
│  │   undici.Agent                     │ │
│  │   - bodyTimeout: 0 ✅              │ │
│  └────────────────────────────────────┘ │
│                ↓                         │
│  ┌────────────────────────────────────┐ │
│  │   undici.setGlobalDispatcher       │ │
│  └────────────────────────────────────┘ │
│                ↓                         │
│  ┌────────────────────────────────────┐ │
│  │   undici.fetch ✅                  │ │
│  │   (使用自定义 Agent)                │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### 关键点

1. **内置 undici** 和 **外部 undici** 是**两个独立的实现**
2. `globalThis.fetch` 使用内置 undici（不可配置）
3. `undici.fetch` 使用外部 undici（可配置）
4. 必须使用 `undici.fetch` 才能应用自定义配置

## 性能影响

### 对比测试

| 实现 | 性能 | 配置能力 | 依赖 |
|------|------|---------|------|
| 内置 undici | 高 | ❌ 无 | 无 |
| 外部 undici | 高 | ✅ 完全可配置 | undici 包 |
| Node.js http/https | 中 | ✅ 完全控制 | 无 |

**结论**: 外部 undici 与内置 undici 性能相当，但提供完全的配置能力。

## 注意事项

### 1. 仅影响 Node.js 环境

- ✅ VS Code 扩展（使用 Node.js）
- ❌ CLI 版本（使用 Bun，无此问题）

### 2. keepAlive 超时限制

undici 要求：
- `keepAliveTimeout` ≥ 2000ms
- `keepAliveMaxTimeout` ≥ 6000ms

这些限制**不影响**长时间响应，因为：
- 它们只控制连接复用
- `bodyTimeout: 0` 才是控制响应超时的关键

### 3. 自动回退

如果外部 undici 不可用，会自动回退到 Node.js `http`/`https` 模块，确保功能正常。

## 相关文件

### 核心实现
- `packages/testagent-core/packages/opencode/src/provider/provider.ts` - 主要实现

### 测试脚本
- `test-undici-external.mjs` - 外部 undici 测试
- `test-builtin-undici-research.mjs` - 内置 undici 研究
- `test-bun-fetch.mjs` - Bun fetch 测试

### 文档
- `UNDICI_RESEARCH_REPORT.md` - 深度研究报告
- `BUN_VS_NODEJS_FETCH.md` - Bun vs Node.js 对比
- `UNDICI_TIMEOUT_FIX.md` - 修复方案文档

## 参考资料

### 官方文档
- [Undici 官方文档](https://undici.nodejs.org/)
- [Undici Agent API](https://undici.nodejs.org/#/docs/api/Agent)
- [Node.js Fetch API](https://nodejs.org/docs/latest/api/globals.html#fetch)

### 源码
- [Node.js undici 源码](https://github.com/nodejs/undici)
- [Node.js 内置 undici 集成](https://github.com/nodejs/node/blob/main/lib/internal/deps/undici/undici.js)

### 相关 Issue
- [Node.js Issue #43187: Expose Undici's setGlobalDispatcher](https://github.com/nodejs/node/issues/43187)
- [Undici Discussion #1989: How to increase headersTimeout](https://github.com/nodejs/undici/discussions/1989)

## 总结

### 问题
Node.js 内置 undici 的 bodyTimeout 固定为 300 秒，导致长时间 LLM 响应被中断。

### 解决方案
使用外部 undici 包，配置 `bodyTimeout: 0`，并使用 `undici.fetch` 替代 `globalThis.fetch`。

### 关键代码
```typescript
const undici = await import("undici")
const agent = new undici.Agent({ bodyTimeout: 0, ... })
undici.setGlobalDispatcher(agent)
return undici.fetch  // 关键：使用 undici.fetch
```

### 效果
✅ 支持无限长的 LLM 响应  
✅ 不再出现 5 分钟超时错误  
✅ 自动回退机制保证稳定性  
✅ 仅影响 Node.js 环境，Bun 环境无需修改  

---

**文档版本**: 1.0  
**最后更新**: 2026-05-16  
**作者**: testagent-kilo 团队
