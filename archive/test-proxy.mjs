import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
    const sseTransport = new SSEClientTransport(new URL('http://localhost:3033/sse'));
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await client.connect(sseTransport);
    console.log('Connected!');
    const tools = await client.listTools();
    console.log(tools);
    process.exit(0);
}
main().catch(console.error);
