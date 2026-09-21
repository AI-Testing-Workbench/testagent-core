# api_intel 手动测试指南

> ⚠️ **apicol（API 协作平台）暂未完成，已临时下线**。本指南全部是 apicol 的端到端
> 验证流程，随之暂停：`script/apicol-invoke.ts` 现在是打印下线提示并退出的 stub，
> 原脚本体注释保留。恢复 apicol 时（见 `routes.ts` / `index.ts` 的「apicol 恢复」
> 注释块、以及 `script/apicol-invoke.ts` 的块注释）取消注释后，本指南即可重新使用。
>
> FA 平台当前仅支持 in-process 单测：`bun test test/plugin/testagent-api-intel/`。

目标：在不构建单文件二进制、不安装 VSIX 的情况下，端到端验证 `api_intel` 工具的真实四端点链路。

## 1. 环境
- 仓库根：`packages/testagent-core/`
- Node/Bun：`bun@1.3.13`（仓库固定）
- 测试不依赖 VS Code，只用 Bun 直连源码

## 2. 启动本地 apicol mock
```bash
cd packages/testagent-core/packages/opencode
bun run script/apicol-mock-server.ts
# 默认端口 9999；可设 PORT=9999 HOST=127.0.0.1
```
可用 `curl 'http://127.0.0.1:9999/ed/openapi/token?sapId=80249496'` 验证。

mock 已实现的端点：
- `GET  /ed/openapi/token?sapId=...`
- `GET  /ed/openapi/system/{systemId}/deploy-unit`
- `GET  /ed/openapi/system/{systemId}/project/page`
- `POST /ed/openapi/project/user/api/list` body `{ projectId }`
- `POST /ed/openapi/project/user/swagger` body `{ projectId, swaggerVersion }`

返回约定：`{ returnCode: "SUC0000", body: ... }`；失败 `{ returnCode, errorMsg }`。
mock 内置 3 个接口（含 1 个 `DESIGNING` 状态，用以验证过滤）。

## 3. 直接调用 plugin 函数（推荐调试入口）
新脚本：`script/apicol-invoke.ts`，绕开 opencode server，直接调用 `executeAction`，最快验证工具行为。

```bash
# 注入用户身份；指向上一步的 mock
export APICOL_BASE_URL=http://127.0.0.1:9999
export TESTAGENT_USER_ID=u-debug
export TESTAGENT_SAP_ID=80249496

cd packages/testagent-core/packages/opencode

bun run script/apicol-invoke.ts scan     --systemId LT37.01 --keyword demo
bun run script/apicol-invoke.ts list     --appId 1279
bun run script/apicol-invoke.ts fetch    --appId 1279 --refs users_create --refs "POST /api/users"
bun run script/apicol-invoke.ts fetch    --appId 1279 --refs users_typo
bun run script/apicol-invoke.ts fetchAll --appId 1279
```
预期：
- `scan` 返回 `apps: [{appId:"1279",...},{appId:"1280",...}]`，并触发 1 次 token 请求 + N 次业务请求。
- `list` 返回 2 条接口（DESIGNING 被过滤到 `skipped`）。
- `fetch users_create` 命中并带 swagger schema；`fetch "POST /api/users"` 也命中；`users_typo` 未命中带 candidates。
- `fetchAll` 只返回 endpoint 清单（不带 definition）。

## 4. 在真实 OpenCode Server 里跑（可选，需要本地构建）
当 mock 与 invoke 脚本都通过后，可以走完整插件链路：
1. 在扩展里 `PUT /testagent/user` 注入 `sapId`。
2. 在 VS Code 任务里让 Agent 调用 `api_intel` 工具，传 `systemId` / `appId` / `endpointRefs`。
3. 服务端日志应能看到 `/ed/openapi/token` 调用与对应业务调用。

## 5. 打包（仓库推荐路径）
```bash
cd packages/testagent-core/packages/opencode
bun run build --target=win32-x64 --skip-models --skip-install
mkdir -p ../kilo-vscode/bin
cp dist/testagent-win32-x64/bin/testagent.exe ../kilo-vscode/bin/testagent.exe
```
也可参考仓库根 `bun run bun:windows` / `bun run bun:mac` 等脚本。

## 6. 常见检查
- `sapId` 没注入时 `fetch/list` 报 `"apicol: 获取 token 失败"` —— 注入后正常。
- `Authorization` 头应等于 token mock 返回值；token 接口**不**带 Authorization。
- `projectId` 一律按字符串传递；mock 接受 `"1279"`。
- `DESIGNING` 接口自动进入 `skipped`，不会再进 `fetch` 的 candidates。