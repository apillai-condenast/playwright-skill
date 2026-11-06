import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function connect() {
  const client = new Client({ name: 'copilot-asset-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PLAYWRIGHT_MCP_URL || 'http://127.0.0.1:8931/mcp')));
  return client;
}
export async function call(client, name, args = {}) {
  const result = await client.callTool({ name: `browser_${name}`, arguments: args });
  if (result.isError) throw new Error(result.content?.map(x => x.text).join('\n'));
  return result.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '';
}
if (process.argv[1]?.endsWith('/mcp.mjs') && process.argv[2]) {
  const client = await connect();
  try { console.log(await call(client, process.argv[2], JSON.parse(process.argv[3] || '{}'))); }
  finally { await client.close(); }
}
