import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import path from 'path';

export interface McpServerConfig {
  transport?: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export class McpManager {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport | SSEClientTransport> = new Map();
  // Cache tools to avoid redundant network calls and ambiguous routing
  private toolCache: Map<string, string> = new Map(); // toolName -> serverName

  constructor() {}

  async connect(name: string, config: McpServerConfig) {
    try {
      console.log(`[McpManager] Connecting to ${name}...`);
      
      let transport: StdioClientTransport | SSEClientTransport;

      if (config.transport === 'sse' && config.url) {
          transport = new SSEClientTransport(new URL(config.url));
      } else {
          // Default to stdio
          const env: Record<string, string> = { ...config.env };
          // Copy process.env but ensure string values
          for (const key in process.env) {
              const val = process.env[key];
              if (val !== undefined) {
                  env[key] = val;
              }
          }

          if (!config.command) {
              throw new Error(`MCP Server ${name} missing 'command' for stdio transport.`);
          }

          const resolvedArgs = (config.args || []).map((arg) => {
              if (typeof arg !== 'string') return String(arg);
              const trimmed = arg.trim();
              if (trimmed === '.' || trimmed === './' || trimmed === '.\\') return process.cwd();
              if (trimmed.startsWith('./') || trimmed.startsWith('.\\')) return path.resolve(process.cwd(), trimmed);
              return arg;
          });

          transport = new StdioClientTransport({
            command: config.command,
            args: resolvedArgs,
            env: env
          });
      }

      const client = new Client(
        {
          name: "GitubotClient",
          version: "1.0.0",
        },
        {
          capabilities: {
            sampling: {},
          },
        }
      );

      await client.connect(transport);
      
      this.clients.set(name, client);
      this.transports.set(name, transport);
      
      console.log(`[McpManager] Connected to ${name}`);
      
      // Initial cache population
      await this.refreshToolCache(name);

    } catch (error) {
      console.error(`[McpManager] Failed to connect to ${name}:`, error);
    }
  }

  private async refreshToolCache(serverName: string) {
      const client = this.clients.get(serverName);
      if (!client) return;

      try {
        const result = await client.request(
            { method: "tools/list" },
            ListToolsResultSchema
        );
        
        if (result.tools) {
            result.tools.forEach((tool: any) => {
                this.toolCache.set(tool.name, serverName);
            });
        }
      } catch (error) {
          console.error(`[McpManager] Failed to list tools for cache from ${serverName}:`, error);
      }
  }

  async listTools() {
    const allTools: any[] = [];
    
    for (const [name, client] of this.clients.entries()) {
      try {
        const result = await client.request(
            { method: "tools/list" },
            ListToolsResultSchema
        );
        
        if (result.tools) {
            result.tools.forEach((tool: any) => {
                allTools.push({
                    ...tool,
                    source: name // Tag the tool with its source server
                });
                // Update cache while we are at it
                this.toolCache.set(tool.name, name);
            });
        }
      } catch (error) {
        console.error(`[McpManager] Failed to list tools from ${name}:`, error);
      }
    }
    return allTools;
  }

  async callTool(name: string, args: any, sourceServer?: string) {
    // 1. Try explicit source
    if (sourceServer && this.clients.has(sourceServer)) {
        return this.executeToolCall(this.clients.get(sourceServer)!, name, args);
    }

    // 2. Try cache
    const cachedServer = this.toolCache.get(name);
    if (cachedServer && this.clients.has(cachedServer)) {
        return this.executeToolCall(this.clients.get(cachedServer)!, name, args);
    }

    // 3. Fallback: Search all servers (and update cache if found)
    for (const [serverName, client] of this.clients.entries()) {
        try {
            // Optimistic call attempt? No, safest is to list first or just try calling.
            // Some servers might error if called with unknown tool.
            // Let's re-list to be safe, though slow.
            const tools = await client.request(
                { method: "tools/list" },
                ListToolsResultSchema
            );
            
            if (tools.tools.find((t: any) => t.name === name)) {
                this.toolCache.set(name, serverName);
                return this.executeToolCall(client, name, args);
            }
        } catch (e) {
            continue;
        }
    }
    
    throw new Error(`Tool ${name} not found in any connected MCP server.`);
  }

  private async executeToolCall(client: Client, name: string, args: any) {
      const result = await client.request(
          {
              method: "tools/call",
              params: {
                  name: name,
                  arguments: args
              }
          },
          CallToolResultSchema
      );
      
      // Flatten result for easier consumption
      if (result.content && result.content.length > 0) {
          // If text content, join it.
          const textContent = result.content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
            
          if (textContent) return textContent;
          
          // If only other types (e.g. image), return raw or stringified
          return JSON.stringify(result.content);
      }
      
      return "Success (No Output)";
  }

  async closeAll() {
    for (const client of this.clients.values()) {
        try {
            await client.close();
        } catch (e) { /* ignore */ }
    }
  }
}
