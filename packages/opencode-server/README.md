# OpenCode Server - Node.js Distribution

Standalone Node.js server for OpenCode AI, designed for environments where Bun runtime is not available (e.g., Windows).

## Requirements

- Node.js >= 22.5.0
- The `--experimental-sqlite` flag is required to enable `node:sqlite`

## Installation

```bash
npm install
```

## Usage

### Basic Start

```bash
node --experimental-sqlite cli.mjs
```

The server will start on `http://0.0.0.0:4096` by default.

### Command Line Options

```bash
node --experimental-sqlite cli.mjs \
  --port 4096 \
  --hostname 127.0.0.1 \
  --password your-secret-password \
  --username opencode
```

**Options:**

- `--port` - Server port (default: `4096`)
- `--hostname` - Server hostname (default: `0.0.0.0`)
- `--password` - Authentication password (optional)
- `--username` - Authentication username (default: `opencode`)

### Environment Variables

You can also configure authentication via environment variables:

```bash
export OPENCODE_SERVER_PASSWORD=your-secret-password
export OPENCODE_SERVER_USERNAME=opencode
node --experimental-sqlite cli.mjs
```

## Connecting with SDK

```typescript
import { OpenCode } from "@opencode-ai/sdk"

const client = new OpenCode({
  baseURL: "http://127.0.0.1:4096",
  auth: {
    username: "opencode",
    password: "your-secret-password",
  },
})

const session = await client.sessions.create({
  projectPath: "/path/to/project",
})
```

## Building from Source

```bash
cd packages/opencode-server
bun run build
```

This will:
1. Build the Node.js bundle from `packages/opencode`
2. Copy all necessary files to `dist/`
3. Include WASM resources for tree-sitter
4. Generate distribution `package.json`

## Platform Support

The package includes precompiled binaries for `@lydell/node-pty` on:
- macOS (x64, arm64)
- Linux (x64, arm64)
- Windows (x64, arm64)

## Health Check

Verify the server is running:

```bash
curl http://127.0.0.1:4096/global/health
```

## Features

- ✅ HTTP Server + REST API
- ✅ WebSocket (real-time events)
- ✅ SQLite database
- ✅ PTY terminal support
- ✅ AI Provider integration
- ✅ MCP protocol
- ✅ Plugin system
- ✅ Session management
- ✅ Agent execution
- ✅ File watching
- ✅ Tree-sitter parsing
- ✅ mDNS discovery

## License

See [LICENSE](../../LICENSE)
