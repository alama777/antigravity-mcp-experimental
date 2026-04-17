import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { createExpressApp, AppContext } from './appBuilder';

let expressServer: http.Server | null = null;
let outputChannel: vscode.OutputChannel;

/**
 * Safely writes a JSON configuration file using an atomic rename operation.
 * Includes a retry mechanism to handle intermittent Windows file locking (EPERM/EBUSY)
 * which can occur if another process (e.g. an MCP client) is concurrently reading the file.
 */
function atomicWriteJsonFile(configPath: string, data: any): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tempConfigPath = configPath + `.${Date.now()}.tmp`;
    fs.writeFileSync(tempConfigPath, JSON.stringify(data, null, 2), 'utf8');
    
    let renamed = false;
    let lastErr: any;
    // Retry up to 5 times to bypass temporary read locks
    for (let i = 0; i < 5; i++) {
        try {
            fs.renameSync(tempConfigPath, configPath);
            renamed = true;
            break;
        } catch (err: any) {
            lastErr = err;
            if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
                const start = Date.now();
                // Synchronous wait for 10ms before retrying to prevent blocking the event loop too long
                while (Date.now() - start < 10) { /* wait */ }
            } else {
                break;
            }
        }
    }
    
    if (!renamed) {
        try { fs.unlinkSync(tempConfigPath); } catch (e) {} // Clean up the orphaned temp file
        throw lastErr || new Error(`Failed to safely write ${configPath} due to consecutive file locks`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Antigravity MCP');
    outputChannel.appendLine('[System] Extension activated. Merged Rev 30 loaded.');

    process.on('uncaughtException', (err) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Uncaught Exception: ${err.message}\n${err.stack}`);
    });
    process.on('unhandledRejection', (reason) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Unhandled Rejection: ${reason}`);
    });


    /**
     * Dynamically registers the Antigravity proxy as an MCP server.
     * This automatically injects the proxy configuration into the global MCP settings file,
     * allowing external agents (like Roo-Code or Claude Desktop) to connect seamlessly.
     */
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
            if (existingServerConfig.disabledTools !== undefined) {
                newMcpConfig.disabledTools = existingServerConfig.disabledTools;
            }

            if (currentMcpStr !== JSON.stringify(newMcpConfig)) {
                config.mcpServers[serverName] = newMcpConfig;
                
                // Save the configuration atomically to prevent race conditions
                // where the MCP client reads a partially written or empty file.
                atomicWriteJsonFile(configPath, config);
                
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
