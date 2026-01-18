#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync, watch } from "fs";
import { homedir } from "os";
import { join } from "path";
import MiniSearch from "minisearch";
import { LRUCache } from "lru-cache";

interface UpstreamConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  transport?: "streamable_http" | "websocket";
  endpoint?: string;
  enabled?: boolean;
}

interface GatewayConfig {
  [serverKey: string]: UpstreamConfig;
}

interface ToolCatalogEntry {
  id: string; // serverKey::toolName
  server: string;
  name: string;
  title?: string;
  description?: string;
  inputSchema?: any;
  outputSchema?: any;
}

interface SearchFilters {
  server?: string;
  tags?: string[];
}

interface JobRecord {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  toolId: string;
  args: any;
  priority?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: any;
  error?: string;
  logs: string[];
}

class MCPGateway {
  private server: Server;
  private config: GatewayConfig;
  private configPath: string;
  private upstreams: Map<string, Client> = new Map();
  private catalog: Map<string, ToolCatalogEntry> = new Map();
  private jobs = new LRUCache<string, JobRecord>({
    max: 500,
    ttl: 1000 * 60 * 60 * 24, // 24 hours
  });
  private jobQueue: string[] = [];
  private runningJobs = 0;
  private maxConcurrentJobs = 3;
  private miniSearch: MiniSearch<ToolCatalogEntry> | null = null;
  private indexDirty = true; // Mark index as needing rebuild

  private ensureSearchIndex() {
    if (!this.indexDirty) return;
    this.initSearchIndex();
    this.indexDirty = false;
  }

  private initSearchIndex() {
    const tools = Array.from(this.catalog.values());
    if (tools.length === 0) {
      this.miniSearch = null;
      return;
    }

    this.miniSearch = new MiniSearch<ToolCatalogEntry>({
      fields: ["name", "title", "description", "server"],
      storeFields: ["id", "server", "name", "title", "description", "inputSchema", "outputSchema", "sideEffecting"],
      searchOptions: {
        boost: { name: 3, title: 2 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });

    this.miniSearch.addAll(tools);
  }

  constructor(configPath?: string) {
    // Determine config path
    this.configPath =
      configPath ||
      process.env.MCP_GATEWAY_CONFIG ||
      join(homedir(), ".config", "mcp-gateway", "config.json");

    // Load config
    if (!existsSync(this.configPath)) {
      console.error(`Config not found: ${this.configPath}`);
      this.config = {};
    } else {
      this.config = JSON.parse(readFileSync(this.configPath, "utf-8"));
    }

    // Initialize server
    this.server = new Server(
      { name: "mcp-gateway", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  private loadConfig(): GatewayConfig {
    if (!existsSync(this.configPath)) {
      console.error(`Config not found: ${this.configPath}`);
      return {};
    }
    return JSON.parse(readFileSync(this.configPath, "utf-8"));
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "gateway.search",
          description:
            "Search for tools across all connected MCP servers. Returns matching tools with relevance scores.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: {
                type: "number",
                description: "Max results (default 10, max 50)",
                default: 10,
              },
              filters: {
                type: "object",
                properties: {
                  server: {
                    type: "string",
                    description: "Filter by server key",
                  },
                },
              },
            },
            required: ["query"],
          },
        },
        {
          name: "gateway.describe",
          description:
            "Get detailed information about a specific tool including full schema.",
          inputSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Tool ID in format 'server::toolName'",
              },
            },
            required: ["id"],
          },
        },
        {
          name: "gateway.invoke",
          description: "Execute a tool synchronously and return the result.",
          inputSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Tool ID in format 'server::toolName'",
              },
              args: {
                type: "object",
                description: "Arguments to pass to the tool",
              },
              timeoutMs: {
                type: "number",
                description: "Timeout in milliseconds (default 30000)",
              },
            },
            required: ["id", "args"],
          },
        },
        {
          name: "gateway.invoke_async",
          description:
            "Start an asynchronous tool execution and return a job ID for polling.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Tool ID" },
              args: { type: "object", description: "Tool arguments" },
              priority: {
                type: "number",
                description: "Job priority (higher = sooner)",
              },
              timeoutMs: { type: "number", description: "Timeout in ms" },
            },
            required: ["id", "args"],
          },
        },
        {
          name: "gateway.invoke_status",
          description: "Check the status of an async job.",
          inputSchema: {
            type: "object",
            properties: {
              jobId: {
                type: "string",
                description: "Job ID from invoke_async",
              },
            },
            required: ["jobId"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "gateway.search":
            return await this.handleSearch(args);
          case "gateway.describe":
            return await this.handleDescribe(args);
          case "gateway.invoke":
            return await this.handleInvoke(args);
          case "gateway.invoke_async":
            return await this.handleInvokeAsync(args);
          case "gateway.invoke_status":
            return await this.handleInvokeStatus(args);
          default:
            throw new Error(`Unknown gateway tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  private async handleSearch(args: any): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { query, limit = 10, filters = {} } = args;
    const maxLimit = Math.min(limit, 50);

    const results = this.searchCatalog(query, filters).slice(0, maxLimit);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { query, found: results.length, results },
            null,
            2,
          ),
        },
      ],
    };
  }

  private async handleDescribe(args: any): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { id } = args;
    const tool = this.catalog.get(id);

    if (!tool) {
      throw new Error(`TOOL_NOT_FOUND: ${id}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(tool, null, 2) }],
    };
  }

  private async handleInvoke(args: any): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    const { id, args: toolArgs, timeoutMs = 30000 } = args;
    const [serverKey, toolName] = id.split("::");

    if (!serverKey || !toolName) {
      throw new Error(`Invalid tool ID format: ${id}`);
    }

    const client = this.upstreams.get(serverKey);
    if (!client) {
      throw new Error(`SERVER_NOT_FOUND: ${serverKey}`);
    }

    const tool = this.catalog.get(id);
    if (!tool) {
      throw new Error(`TOOL_NOT_FOUND: ${id}`);
    }

    // Execute with timeout
    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: toolArgs }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
      ),
    ]);

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handleInvokeAsync(args: any): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { id, args: toolArgs, priority = 0, timeoutMs = 60000 } = args;

    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const job: JobRecord = {
      id: jobId,
      status: "queued",
      toolId: id,
      args: toolArgs,
      priority,
      createdAt: Date.now(),
      logs: [`Job created: ${id}`],
    };

    this.jobs.set(jobId, job);
    this.jobQueue.push(jobId);
    this.jobQueue.sort(
      (a, b) =>
        (this.jobs.get(b)?.priority || 0) - (this.jobs.get(a)?.priority || 0),
    );

    this.processJobQueue();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ jobId, status: "queued" }, null, 2),
        },
      ],
    };
  }

  private async handleInvokeStatus(args: any): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const { jobId } = args;
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error(`JOB_NOT_FOUND: ${jobId}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }],
    };
  }

  private searchCatalog(query: string, filters: SearchFilters) {
    // Ensure search index is ready
    this.ensureSearchIndex();

    if (!this.miniSearch || !query.trim()) {
      return [];
    }

    // Perform search with BM25 scoring
    const results = this.miniSearch.search(query.toLowerCase()).slice(0, 100);

    // Apply filters and sort
    const filtered = results
      .filter((result) => {
        // Server filter
        if (filters.server && result.server !== filters.server) return false;
        return true;
      })
      .map((result) => ({
        ...(result as any),
        score: result.score || 0,
      }))
      .sort((a, b) => b.score - a.score);

    return filtered;
  }

  private async processJobQueue() {
    while (
      this.runningJobs < this.maxConcurrentJobs &&
      this.jobQueue.length > 0
    ) {
      const jobId = this.jobQueue.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;

      this.runningJobs++;
      this.executeJob(job).finally(() => {
        this.runningJobs--;
        this.processJobQueue();
      });
    }
  }

  private async executeJob(job: JobRecord) {
    job.status = "running";
    job.startedAt = Date.now();
    job.logs.push(`Started execution`);

    try {
      const result = await this.handleInvoke({
        id: job.toolId,
        args: job.args,
        timeoutMs: 60000,
      });

      job.status = "completed";
      job.result = result;
      job.finishedAt = Date.now();
      job.logs.push(`Completed successfully`);
    } catch (error: any) {
      job.status = "failed";
      job.error = error.message;
      job.finishedAt = Date.now();
      job.logs.push(`Failed: ${error.message}`);
    }
  }

  private async connectUpstream(serverKey: string, config: UpstreamConfig) {
    if (config.type === "local") {
      await this.connectLocalUpstream(serverKey, config);
    } else {
      await this.connectRemoteUpstream(serverKey, config);
    }
  }

  private async connectLocalUpstream(
    serverKey: string,
    config: UpstreamConfig,
  ) {
    if (!config.command) {
      throw new Error(`Missing command for local server: ${serverKey}`);
    }

    const [cmd, ...args] = config.command;
    if (!cmd) {
      throw new Error(`Empty command for local server: ${serverKey}`);
    }

    const transport = new StdioClientTransport({
      command: cmd,
      args,
    });

    // Log connection events
    transport.onclose = () => {
      console.error(`[${serverKey}] Connection closed`);
    };
    transport.onerror = (error) => {
      console.error(`[${serverKey}] Connection error:`, error.message);
    };

    const client = new Client(
      { name: `gateway-${serverKey}`, version: "1.0.0" },
      {},
    );

    await client.connect(transport);
    this.upstreams.set(serverKey, client);

    // Fetch tools
    await this.refreshCatalog(serverKey, client);

    console.error(
      `[${serverKey}] Connected with ${this.countToolsForServer(serverKey)} tools`,
    );
  }

  private async connectRemoteUpstream(
    serverKey: string,
    config: UpstreamConfig,
  ) {
    if (!config.url) {
      throw new Error(`Missing URL for remote server: ${serverKey}`);
    }

    const url = new URL(config.url);
    let transport;

    // Determine transport type based on config or URL protocol
    const transportType = config.transport || (url.protocol === "ws:" || url.protocol === "wss:" ? "websocket" : "streamable_http");

    switch (transportType) {
      case "websocket":
        transport = new WebSocketClientTransport(url);
        break;
      case "streamable_http":
      default:
        transport = new StreamableHTTPClientTransport(url);
        break;
    }

    // Log connection events
    transport.onclose = () => {
      console.error(`[${serverKey}] Connection closed`);
    };
    transport.onerror = (error) => {
      console.error(`[${serverKey}] Connection error:`, error.message);
    };

    const client = new Client(
      { name: `gateway-${serverKey}`, version: "1.0.0" },
      {},
    );

    await client.connect(transport);
    this.upstreams.set(serverKey, client);

    // Fetch tools
    await this.refreshCatalog(serverKey, client);

    console.error(
      `[${serverKey}] Connected (${transportType}) with ${this.countToolsForServer(serverKey)} tools`,
    );
  }

  private async refreshCatalog(serverKey: string, client: Client) {
    const response = await client.listTools();

    for (const tool of response.tools) {
      const id = `${serverKey}::${tool.name}`;
      this.catalog.set(id, {
        id,
        server: serverKey,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }

    // Mark index as dirty (will be rebuilt on first search or at startup)
    this.indexDirty = true;
  }

  private countToolsForServer(serverKey: string): number {
    return Array.from(this.catalog.values()).filter(
      (t) => t.server === serverKey,
    ).length;
  }

  private async connectWithRetry(
    serverKey: string,
    config: UpstreamConfig,
    maxRetries = 5,
    baseDelay = 1000,
  ) {
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.connectUpstream(serverKey, config);
      } catch (error) {
        lastError = error as Error;
        if (i < maxRetries - 1) {
          const delay = baseDelay * Math.pow(2, i);
          console.error(
            `[${serverKey}] Connection failed (attempt ${i + 1}/${maxRetries}), retrying in ${delay}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`[${serverKey}] Failed after ${maxRetries} attempts: ${lastError?.message}`);
    throw lastError;
  }

  async start() {
    console.error("MCP Gateway starting...");

    // Connect all upstreams in parallel with retry
    const connections = Object.entries(this.config)
      .filter(([_, cfg]) => cfg.enabled !== false)
      .map(([key, cfg]) => this.connectWithRetry(key, cfg));

    const results = await Promise.allSettled(connections);

    // Report results
    let successful = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") successful++;
      else {
        failed++;
        console.error(`Connection failed: ${result.reason?.message}`);
      }
    }

    // Build search index once after all tools are loaded
    this.initSearchIndex();
    this.indexDirty = false;

    console.error(
      `Gateway ready: ${this.catalog.size} tools from ${successful} servers (${failed} failed)`,
    );

    // Warmup search with a test query
    this.searchCatalog("", {});
    console.error("Search index warmed up");

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Start watching config file for changes
    this.watchConfig();
  }

  private watchConfig() {
    const configPath = this.configPath;
    if (!configPath) return;

    let debounceTimer: NodeJS.Timeout | null = null;

    watch(configPath, (eventType: string) => {
      if (eventType !== "change") return;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = setTimeout(async () => {
        try {
          const newConfig = this.loadConfig();
          await this.reloadConfig(newConfig);
        } catch (error) {
          console.error("Config reload error:", (error as Error).message);
        }
      }, 1000);
    });

    console.error(`  Watching config file: ${configPath}`);
  }

  async stop() {
    console.error("Shutting down gateway...");

    // Stop accepting new jobs
    this.maxConcurrentJobs = 0;

    // Wait for running jobs to complete (max 30 seconds)
    const shutdownTimeout = 30000;
    const startTime = Date.now();

    while (this.runningJobs > 0 && Date.now() - startTime < shutdownTimeout) {
      console.error(`  Waiting for ${this.runningJobs} jobs to complete...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (this.runningJobs > 0) {
      console.error(`  Timeout waiting for jobs, force shutdown with ${this.runningJobs} running`);
    } else {
      console.error("  All jobs completed");
    }

    // Close all upstream connections
    console.error("  Closing upstream connections...");
    for (const [key, client] of this.upstreams.entries()) {
      try {
        await client.close();
        console.error(`    ${key} closed`);
      } catch (error) {
        console.error(`    ${key} close error: ${(error as Error).message}`);
      }
    }

    console.error("Gateway shutdown complete");
  }

  private async reloadConfig(newConfig: GatewayConfig) {
    console.error("Reloading configuration...");

    const oldServers = new Set(Object.keys(this.config));
    const newServers = new Set(Object.keys(newConfig));

    const toRemove = [...oldServers].filter((s) => !newServers.has(s));
    const toAdd = [...newServers].filter((s) => !oldServers.has(s));
    const toUpdate = [...newServers].filter((s) => oldServers.has(s));

    console.error(`  Servers to add: ${toAdd.length}`);
    console.error(`  Servers to remove: ${toRemove.length}`);
    console.error(`  Servers to update: ${toUpdate.length}`);

    for (const serverKey of toRemove) {
      const client = this.upstreams.get(serverKey);
      if (client) {
        try {
          await client.close();
          console.error(`    ${serverKey} disconnected`);
        } catch (error) {
          console.error(`    ${serverKey} disconnect error: ${(error as Error).message}`);
        }
        this.upstreams.delete(serverKey);

        for (const [id, tool] of this.catalog.entries()) {
          if (tool.server === serverKey) {
            this.catalog.delete(id);
          }
        }
      }
    }

    for (const serverKey of toUpdate) {
      const oldCfg = this.config[serverKey];
      const newCfg = newConfig[serverKey];

      if (!oldCfg || !newCfg) continue;

      if (oldCfg.enabled === false && newCfg.enabled !== false) {
        try {
          await this.connectWithRetry(serverKey, newCfg);
          console.error(`    ${serverKey} connected`);
        } catch (error) {
          console.error(`    ${serverKey} connection failed: ${(error as Error).message}`);
        }
      } else if (oldCfg.enabled !== false && newCfg.enabled === false) {
        const client = this.upstreams.get(serverKey);
        if (client) {
          try {
            await client.close();
            console.error(`    ${serverKey} disconnected`);
          } catch (error) {
            console.error(`    ${serverKey} disconnect error: ${(error as Error).message}`);
          }
          this.upstreams.delete(serverKey);

          for (const [id, tool] of this.catalog.entries()) {
            if (tool.server === serverKey) {
              this.catalog.delete(id);
            }
          }
        }
      }
    }

    for (const serverKey of toAdd) {
      const newCfg = newConfig[serverKey];
      if (newCfg && newCfg.enabled !== false) {
        try {
          await this.connectWithRetry(serverKey, newCfg);
          console.error(`    ${serverKey} connected`);
        } catch (error) {
          console.error(`    ${serverKey} connection failed: ${(error as Error).message}`);
        }
      }
    }

    this.config = newConfig;
    this.initSearchIndex();
    this.indexDirty = false;

    console.error(
      `Config reloaded: ${this.catalog.size} tools from ${this.upstreams.size} servers`,
    );
  }
}

const gateway = new MCPGateway(process.argv[2]);

gateway.start().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => gateway.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => gateway.stop().then(() => process.exit(0)));
