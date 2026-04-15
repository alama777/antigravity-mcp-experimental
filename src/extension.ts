import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createExpressApp, AppContext } from './appBuilder';

let expressServer: http.Server | null = null;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Antigravity MCP');
    outputChannel.appendLine('[System] Extension activated. Merged Rev 30 loaded.');

    process.on('uncaughtException', (err) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Uncaught Exception: ${err.message}\n${err.stack}`);
    });
    process.on('unhandledRejection', (reason) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Unhandled Rejection: ${reason}`);
    });


    function registerMcpServer() {
        try {
            const proxyPath = path.join(context.extensionPath, 'bin', 'stdio-proxy.mjs');
            const configPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');

            let config: any = { mcpServers: {} };
            if (fs.existsSync(configPath)) {
                try {
                    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                } catch (e) {
                    if (outputChannel) outputChannel.appendLine(`[System] Warning: Could not parse ${configPath}, creating new one.`);
                }
            }

            if (!config.mcpServers) config.mcpServers = {};

            const serverName = "AntigravityMCP";
            const existingServerConfig = config.mcpServers[serverName] || {};
            const currentMcpStr = JSON.stringify(existingServerConfig);

            const mcpSettings = vscode.workspace.getConfiguration('antigravity-mcp');
            const port = mcpSettings.get<number>('port') || 3033;
            const host = mcpSettings.get<string>('host') || '127.0.0.1';

            const newMcpConfig: any = {
                "command": "node",
                "args": [proxyPath, "--host", host, "--port", port.toString()]
            };

            if (existingServerConfig.disabled === true) {
                newMcpConfig.disabled = true;
            }

            if (currentMcpStr !== JSON.stringify(newMcpConfig)) {
                config.mcpServers[serverName] = newMcpConfig;
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
                if (outputChannel) outputChannel.appendLine(`[System] Successfully registered MCP server dynamically.`);
            } else {
                if (outputChannel) outputChannel.appendLine(`[System] MCP server is already correctly registered.`);
            }
        } catch (e: any) {
            if (outputChannel) outputChannel.appendLine(`[System Error] Failed to register MCP server automatically: ${e.message}`);
        }
    }

    registerMcpServer();

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('antigravity-mcp.port') || e.affectsConfiguration('antigravity-mcp.host')) {
            registerMcpServer();
            if (expressServer) {
                vscode.commands.executeCommand('antigravity-mcp.stopServer').then(() => {
                    setTimeout(() => {
                        vscode.commands.executeCommand('antigravity-mcp.startServer');
                    }, 500); // give the port half a second to free up
                });
            }
        }
    }));

    const startCmd = vscode.commands.registerCommand('antigravity-mcp.startServer', () => {
        if (expressServer) {
            vscode.window.showInformationMessage('Antigravity MCP Server is already running');
            return;
        }

        const appContext: AppContext = {
            getConfig: <T>(key: string) => vscode.workspace.getConfiguration('antigravity-mcp').get<T>(key),
            executeCommand: (cmd: string, ...args: any[]) => Promise.resolve(vscode.commands.executeCommand(cmd, ...args)),
            log: (msg: string) => outputChannel.appendLine(msg)
        };

        const app = createExpressApp(appContext);

        const port = appContext.getConfig<number>('port') || 3033;

        expressServer = app.listen(port, () => {
            const msg = `Antigravity MCP & Bridge is running on http://127.0.0.1:${port}`;
            vscode.window.showInformationMessage(msg);
            outputChannel.appendLine(`[Server] ${msg}`);
        });
    });

    const stopCmd = vscode.commands.registerCommand('antigravity-mcp.stopServer', () => {
        if (expressServer) {
            expressServer.close();
            expressServer = null;
            vscode.window.showInformationMessage('Antigravity MCP Server stopped');
            outputChannel.appendLine('[Server] Server stopped');
        }
    });

    context.subscriptions.push(startCmd, stopCmd);
    vscode.commands.executeCommand('antigravity-mcp.startServer');
}

export function deactivate() {
    if (expressServer) {
        expressServer.close();
    }
}
