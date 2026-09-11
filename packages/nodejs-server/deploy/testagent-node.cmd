@echo off
rem testagent-core_change - new file
rem agent host 只会传 `serve --port=0`，node 版 CLI 不认位置参数，这里做参数翻译（不转发 %*）。
if "%OPENCODE_SERVER_PASSWORD%"=="" set OPENCODE_SERVER_PASSWORD=dev
node --experimental-sqlite "%~dp0..\nodejs-server\cli.mjs" --hostname 127.0.0.1 --port 0
