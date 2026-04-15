import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
async function main() {
    try {
        let host = "127.0.0.1";
        let port = "3033";
        let client = null;
        let sseTransport = null;

        async function connectToPlugin(targetHost, targetPort) {
            while (true) {
                try {
                    if (sseTransport) {
                        try { await client.close(); } catch(e) {}
                    }
                    const url = new URL(`http://${targetHost}:${targetPort}/sse`);
                    sseTransport = new SSEClientTransport(url);
                    client = new Client({ name: "stdio-proxy-client", version: "1.0.0" }, { capabilities: {} });
                    await client.connect(sseTransport);
                    console.error(`[Proxy] Connected to plugin at ${url}`);
                    return; // Break the retry loop if successful
                } catch (err) {
                    console.error(`[Proxy] Connect failed, retrying in 2s... (${err.message})`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        const args = process.argv.slice(2);
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--host' && args[i + 1]) {
                host = args[i + 1];
                i++;
            } else if (args[i] === '--port' && args[i + 1]) {
                port = args[i + 1];
                i++;
            }
        }

        // Initial connection
        await connectToPlugin(host, port);



        // 2. Открываем Stdio-сервер для связи с внешними агентами (в т.ч. Antigravity Agent)
        const server = new Server(
            { name: "antigravity-bridge-proxy", version: "1.0.0" },
            { capabilities: { tools: {} } }
        );
        
        // Пробрасываем запросы
        server.setRequestHandler(ListToolsRequestSchema, async () => {
            return await client.listTools();
        });
        
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return await client.callTool({
                name: request.params.name,
                arguments: request.params.arguments
            });
        });

        // Запускаем слушатель стандартного ввода/вывода
        const stdioTransport = new StdioServerTransport();
        await server.connect(stdioTransport);
    } catch (e) {
        console.error("Proxy error:", e);
        process.exit(1);
    }
}
main();
