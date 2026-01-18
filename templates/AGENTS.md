# MCP Gateway System Guide

You are connected to an MCP Gateway that provides unified access to multiple tool servers. Follow these patterns to efficiently discover and use tools without hitting context limits.

## Core Principle

**NEVER list all available tools.** The gateway exposes tools from multiple servers (50+ total). Instead, use search-describe-invoke workflow.

## Available Gateway Tools

The gateway provides these tools for tool discovery and execution:

| Tool | Purpose |
|------|---------|
| `gateway.search` | Find relevant tools with BM25 scoring and fuzzy matching |
| `gateway.describe` | Get full schema for a specific tool |
| `gateway.invoke` | Execute a tool synchronously |
| `gateway.invoke_async` | Execute with job queue for long-running operations |
| `gateway.invoke_status` | Check async job status |

## Three-Step Workflow

### 1. Search for Tools

Use `gateway.search` to find what you need:

```json
{
  "query": "kubernetes pods list",
  "limit": 5,
  "filters": { "server": "kubernetes" }
}
```

**Search Features:**
- **BM25 scoring**: Exact matches get highest scores
- **Fuzzy matching**: Handles typos ("kubenetes" → finds kubernetes)
- **Prefix search**: "pod" matches "pods_list"
- **Field boosting**: Name matches (3x), title matches (2x)

**Search Examples:**
- Kubernetes resources? → `"kubernetes pods list"`
- GitHub issues? → `"github issue create"`
- Browser automation? → `"browser navigate url"`
- Documentation lookup? → `"context7 react hooks"`

### 2. Describe Tool Schema

Use `gateway.describe` with the tool ID from search results:

```json
{
  "id": "kubernetes::pods_list"
}
```

This returns the complete schema including all parameters, types, and descriptions.

### 3. Invoke the Tool

Use `gateway.invoke` or `gateway.invoke_async`:

```json
{
  "id": "kubernetes::pods_list",
  "args": { "namespace": "default" },
  "timeoutMs": 30000
}
```

For long-running operations:

```json
{
  "id": "some-server::long-running-task",
  "args": { "param": "value" },
  "priority": 10,
  "timeoutMs": 60000
}
// Returns: { "jobId": "job_123456789_abc123" }
```

Check status with `gateway.invoke_status`:

```json
{
  "jobId": "job_123456789_abc123"
}
```

## Tool ID Format

All tools use `serverKey::toolName` format:
- `kubernetes::pods_list`
- `playwright::browser_navigate`
- `github::search_code`
- `server-name::tool_name`

The `serverKey` is defined in the gateway configuration, not the original server name. Available servers depend on the gateway configuration.

## Common Patterns

### Pattern: Quick Single Tool Use

```
1. Search: "slack send message" (limit: 3)
2. Describe: "slack::post_message"
3. Invoke: {"channel": "#general", "text": "Hello"}
```

### Pattern: Exploring Related Tools

```
1. Search: "kubernetes pods" (limit: 10)
2. Review results, identify the one you need
3. Describe: "kubernetes::pods_list"
4. Invoke: with required args
```

### Pattern: Multi-Step Workflow

```
1. Search: "github repo list" (limit: 5)
2. Invoke: list_repos, note repo name
3. Search: "github issue create" (limit: 5)
4. Invoke: create_issue using repo from step 2
```

### Pattern: Long-Running Operation

```
1. Invoke async: {"priority": 10}
2. Response: {"jobId": "job_123456789_abc123"}
3. Poll: gateway.invoke_status until completed
```

## Best Practices

**DO:**
- Start every task by searching for relevant tools
- Use `limit` (typically 3-10) to control results
- Describe tools before invoking to verify parameters
- Use specific, action-oriented search terms
- Filter by `server` when you know the source

**DON'T:**
- Never search for generic terms - be specific ("kubernetes pods" not "kubernetes")
- Don't guess tool parameters - always describe first
- Don't invoke without confirming the schema
- There's no `list_tools` tool - use search instead

## Search Tips

| Task | Bad Search | Good Search |
|------|-----------|-------------|
| List pods | "kubernetes" | "kubernetes pods list" |
| Create issue | "github" | "github issue create" |
| Navigate URL | "browser" | "browser navigate url" |
| Get component | "button" | "component button" |

## Timeout Guidelines

- Default: 30000ms (30 seconds)
- Quick ops (list, get): 10000ms
- Long ops (deploy, build): 60000ms+
- Async jobs: no timeout, poll with `invoke_status`

## Error Recovery

If a tool invocation fails:
1. Describe the tool again to verify parameters
2. Check error message for missing/invalid arguments
3. Search for alternative tools if needed
4. Adjust timeout if operation timed out
5. For async jobs, check status for progress

## Remember

- You only need 1-3 tools for most tasks
- Search results are ranked by relevance (BM25)
- Tool IDs use `serverKey::toolName` format
- Always describe before invoking
- Use reasonable limits (3-10 results)
- The gateway handles authentication and routing to upstream servers
- Fuzzy matching handles typos automatically

This approach keeps your context focused on the specific tools needed for the current task.
