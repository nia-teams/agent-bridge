// Loaded by Pi from the installed dist directory. Keep the API structural to
// avoid binding this extension to a particular Pi package scope or release.
interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: Text[]; details: Record<string, never> }>;
}
interface Text { type: 'text'; text: string }
interface ExtensionApi { registerTool(tool: ToolDefinition): void }
interface RemoteTool { name: string; description?: string; inputSchema: Record<string, unknown> }

export default async function niaBridgeExtension(pi: ExtensionApi): Promise<void> {
  const { NIA_BRIDGE_MCP_URL: url, NIA_BRIDGE_MCP_TOKEN: token } = process.env;
  if (!url || !token) throw new Error('Missing Nia Bridge MCP endpoint');
  const headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'MCP-Protocol-Version': '2025-03-26' };
  let sequence = 0;
  async function rpc<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const notification = method === 'notifications/initialized';
    const id = ++sequence;
    const response = await fetch(url!, {
      method: 'POST', headers, redirect: 'error', signal,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Nia MCP ${method} failed (HTTP ${response.status})`);
    }
    if (notification) return undefined as T;
    // ToolHttpServer uses stateless JSON responses, not an SSE response stream.
    const body = await response.json() as { id?: number; error?: { message?: string }; result?: T };
    if (body.error) throw new Error(body.error.message ?? `Nia MCP ${method} failed`);
    if (body.id !== id || body.result === undefined) throw new Error(`Invalid Nia MCP ${method} response`);
    return body.result;
  }
  const startup = AbortSignal.timeout(15_000);
  const init = await rpc<{ protocolVersion: string }>('initialize', {
    protocolVersion: headers['MCP-Protocol-Version'], capabilities: {}, clientInfo: { name: 'nia-pi', version: '0.3.5' },
  }, startup);
  headers['MCP-Protocol-Version'] = init.protocolVersion;
  await rpc('notifications/initialized', undefined, startup);
  const { tools } = await rpc<{ tools: RemoteTool[] }>('tools/list', {}, startup);
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.name, description: tool.description ?? '', parameters: tool.inputSchema,
      async execute(_toolCallId, args, signal) {
        const result = await rpc<{ content: Text[]; isError?: boolean }>('tools/call', { name: tool.name, arguments: args }, signal);
        if (result.isError) throw new Error(result.content.map(item => item.text).join('\n') || 'Nia collaboration tool failed');
        return { content: result.content, details: {} };
      },
    });
  }
}
