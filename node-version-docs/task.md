# OpenCode Node.js Server 包实现任务

- `[x]` 创建 `packages/opencode-server/package.json`
- `[x]` 创建 `packages/opencode-server/cli.mjs` 启动入口
- `[x]` 创建 `packages/opencode-server/script/build.ts` 构建组装脚本
- `[x]` 修改 `packages/opencode/script/build-node.ts` 增加 WASM 复制 (已存在)
- `[x]` 创建 `packages/opencode-server/README.md`
- `[x]` 构建验证：运行 build-node.ts + build.ts
- `[x]` 启动验证：node --experimental-sqlite 启动 server
- `[x]` 健康检查验证：curl /global/health
