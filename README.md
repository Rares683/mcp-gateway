# MCP Gateway

MCP Gateway is a server aggregation tool that connects multiple Model Context Protocol (MCP) servers into a single gateway, exposing all tools from connected servers through unified search, describe, and invoke interfaces.

## What is MCP?

The Model Context Protocol (MCP) is an open protocol that enables AI applications to connect with external data sources and tools. MCP servers expose tools that AI clients can call. However, running many MCP servers individually can become unwieldy.

MCP Gateway solves this by acting as a proxy layer that:
- Connects to multiple MCP servers simultaneously
- Aggregates all available tools into a unified catalog
- Provides a single MCP endpoint for AI clients to access tools from all servers

## How It Works

MCP Gateway operates as both an MCP client (connecting to upstream servers) and an MCP server (exposing tools to downstream clients):

```
┌─────────────┐      MCP       ┌─────────────────┐      MCP       ┌──────────────────┐
│  AI Client  │ ◄──────────── │   MCP Gateway   │ ◄──────────── │  Upstream Server │
│ (Claude, etc)│               │  (this gateway) │               │  (playwright,    │
└─────────────┘               └─────────────────┘               │   kubernetes...) │
                                                                  └──────────────────┘
```

1. Gateway starts and reads configuration
2. For each configured upstream server, Gateway spawns a subprocess and connects via stdio
3. Gateway fetches the tool catalog from each server
4. All tools are indexed in a unified catalog with search capabilities
5. AI clients connect to Gateway and can search/invoke any tool from any upstream

## Installation

### From GitHub

```bash
# Install as a dependency
bun add github:eznix86/mcp-gateway

# Or run directly without installation
bunx github:eznix86/mcp-gateway
```

### From Source

```bash
git clone https://github.com/eznix86/mcp-gateway.git
cd mcp-gateway
bun install
```

## Configuration

MCP Gateway reads configuration from a JSON file. By default, it looks for:

1. Path provided as first command-line argument
2. `MCP_GATEWAY_CONFIG` environment variable
3. `~/.config/mcp-gateway/config.json`

### Configuration Format

```json
{
  "server-name": {
    "type": "local",
    "command": ["bun", "run", "/path/to/server.ts"],
    "enabled": true
  },
  "another-server": {
    "type": "local",
    "command": ["npx", "@some/mcp-server"],
    "enabled": true
  }
}
```

Each entry specifies:
- `type`: Currently only "local" is supported
- `command`: Array with command and arguments to spawn the upstream server
- `enabled`: Set to false to skip connecting to this server

## Gateway Tools

When connected to MCP Gateway, clients have access to these gateway-specific tools:

### gateway.search

Search for tools across all connected servers.

```typescript
{
  query: "kubernetes pods",
  limit: 10,  // optional, max 50
  filters: {
    server: "kubernetes",  // optional, filter by server name
    sideEffecting: true    // optional, filter by side-effecting tools
  }
}
```

Returns matching tools with relevance scores. Tools matching in name are boosted.

### gateway.describe

Get detailed information about a specific tool.

```typescript
{
  id: "kubernetes::pods_list"  // format: serverKey::toolName
}
```

Returns the full tool schema including inputSchema.

### gateway.invoke

Execute a tool synchronously and get immediate results.

```typescript
{
  id: "kubernetes::pods_list",
  args: { namespace: "default" },
  timeoutMs: 30000  // optional, default 30 seconds
}
```

### gateway.invoke_async

Start an asynchronous tool execution. Returns a job ID for polling.

```typescript
{
  id: "some-server::long-running-tool",
  args: { ... },
  priority: 10,  // optional, higher values run first
  timeoutMs: 60000
}
```

### gateway.invoke_status

Check the status of an async job.

```typescript
{
  jobId: "job_123456789_abc123"
}
```

## Tool ID Format

All gateway tools use the format `serverKey::toolName` to identify tools:

```
kubernetes::pods_list
playwright::browser_navigate
github::create_issue
```

The `serverKey` is the key name in your configuration file.

## Architecture

### Components

- **MCPGateway class**: Main orchestrator
- **Upstream connection manager**: Spawns and manages subprocess connections to MCP servers
- **Tool catalog**: In-memory index of all available tools with metadata
- **Job queue**: Handles async tool invocations with priority ordering and concurrency limits (max 3 concurrent by default)
- **Search engine**: Relevance-based tool search with synonym support (k8s -> kubernetes, gh -> github, etc.)

### Search Scoring

The search algorithm scores matches as follows:
- Each matching token adds its length to the score
- Tools with matches in the name get a +10 bonus
- Results are sorted by descending score

## Running

```bash
# Default config location
bun run index.ts

# Custom config path
bun run index.ts /path/to/config.json

# Or after building
bun build index.ts --target node
node dist/index.js
```


## License

MIT License. See the [LICENSE](LICENSE).
