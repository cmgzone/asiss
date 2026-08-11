import { McpManager } from '../core/mcp';
import { Skill } from '../core/skills';

export class McpAdminSkill implements Skill {
  name = 'mcp_admin';
  description = 'Inspect connected MCP servers and tools, or disconnect a server. Tool filters and credentials remain configuration-controlled.';
  inputSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list_servers', 'list_tools', 'disconnect'] },
      server: { type: 'string' }
    },
    required: ['action']
  };

  constructor(private readonly manager: McpManager) {}

  async execute(args: any) {
    if (args?.action === 'list_servers') return { success: true, servers: this.manager.listServers() };
    if (args?.action === 'list_tools') return { success: true, tools: await this.manager.listTools() };
    if (args?.action === 'disconnect') {
      const server = String(args?.server || '').trim();
      if (!server) return { success: false, error: 'server is required' };
      return this.manager.disconnect(server);
    }
    return { success: false, error: `Unknown MCP action: ${args?.action}` };
  }
}
