import * as vscode from 'vscode';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fetchChatDOM } from './cdpHelper';

let serverInstance: Server | null = null;
let expressServer: http.Server | null = null;
let outputChannel: vscode.OutputChannel;

// Cache for heavy DOM hits to prevent overload
let cachedSnifferRes: any = null;
let lastSnifferTime = 0;
const SNIFFER_THROTTLE_MS = 2000;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Antigravity MCP');
    outputChannel.appendLine('[System] Extension activated. Merged Rev 30 loaded.');

    process.on('uncaughtException', (err) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Uncaught Exception: ${err.message}\n${err.stack}`);
    });
    process.on('unhandledRejection', (reason) => {
        if (outputChannel) outputChannel.appendLine(`[System Error] Unhandled Rejection: ${reason}`);
    });

    function syncConfigurationToDisk() {
        const config = vscode.workspace.getConfiguration('antigravity-mcp');
        const port = config.get<number>('port') || 3033;
        const host = config.get<string>('host') || 'localhost';

        const configData = { host, port };
        const configPath = path.join(os.tmpdir(), 'antigravity-mcp-config.json');
        try {
            fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf-8');
            if (outputChannel) outputChannel.appendLine(`[System] Synced settings to ${configPath}`);
        } catch (e: any) {
            if (outputChannel) outputChannel.appendLine(`[System Error] Failed to write config: ${e.message}`);
        }
    }

    syncConfigurationToDisk();

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
            const currentMcpStr = JSON.stringify(config.mcpServers[serverName] || {});

            const newMcpConfig = {
                "command": "node",
                "args": [proxyPath]
            };

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
            syncConfigurationToDisk();
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

        const app = express();


        function setupHandlers(server: Server) {
            server.setRequestHandler(ListToolsRequestSchema, async () => {
                return {
                    tools: [
                        {
                            name: 'get_active_chat',
                            description: 'Get ID, title, and message count of the active chat in Antigravity. (Also referred to as active, main, primary chat or active agent). Returns a JSON object with id, title, and messageCount.',
                            inputSchema: { type: 'object', properties: {} }
                        },
                        {
                            name: 'send_prompt',
                            description: 'Send a new prompt to the active chat. (Also referred to as active, main, primary chat or active agent). Returns a confirmation string. Note: this tool only queues the message and does NOT wait for the agent to finish replying.',
                            inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'The text instruction or message to send to the active chat/agent.' } }, required: ['prompt'] }
                        },
                        {
                            name: 'start_new_chat',
                            description: 'Start a new chat with an optional starting prompt. Use this when the user asks to start a new chat or delegate a task to a "new agent". Returns a confirmation string. Note: this tool only queues the message and does NOT wait for the agent to finish replying.',
                            inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'The initial task or message to start the new chat/agent with (optional).' } } }
                        }
                    ]
                };
            });

            server.setRequestHandler(CallToolRequestSchema, async (request) => {
                const name = request.params.name;
                outputChannel.appendLine(`[Tool Call] Executing tool: ${name}`);

                const cdpHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('cdpHost') || 'localhost';
                const cdpPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('cdpPort') || 9222;
                const dashboardHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('host') || 'localhost';
                const dashboardPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('port') || 3033;

                if (name === 'get_active_chat') {
                    const domData = await fetchChatDOM(cdpHost, cdpPort, dashboardHost, dashboardPort);
                    const title = domData.chatTitle || domData.sessionId; // Fallback to sessionId if no title

                    let diag: any = null;
                    try {
                        diag = await vscode.commands.executeCommand('antigravity.getDiagnostics');
                    } catch (e: any) {
                        return { content: [{ type: 'text', text: JSON.stringify({ error: "Failed to fetch diagnostics: " + e.message }) }] };
                    }

                    const parsedDiag = typeof diag === 'string' ? JSON.parse(diag) : diag;
                    const recent = parsedDiag?.recentTrajectories || [];

                    if (!title || ['agent', 'new chat', 'new conversation', 'customization'].includes(title.toLowerCase())) {
                        return { content: [{ type: 'text', text: JSON.stringify({ error: "Focus is on a new/empty chat.", recentChatsCount: recent.length, debug: domData }) }] };
                    }

                    let cleanMatch = title.toLowerCase();
                    let focusedChat = null;

                    if (domData.sessionId) {
                        focusedChat = recent.find((t: any) => t.googleAgentId === domData.sessionId);
                    }

                    if (!focusedChat) {
                        focusedChat = recent.find((t: any) => (t.summary || "").trim().toLowerCase() === cleanMatch);
                    }

                    if (focusedChat) {
                        return {
                            content: [{
                                type: 'text', text: JSON.stringify({
                                    id: focusedChat.googleAgentId,
                                    title: focusedChat.summary,
                                    messageCount: focusedChat.lastStepIndex
                                })
                            }]
                        };
                    } else {
                        return { content: [{ type: 'text', text: JSON.stringify({ error: "Active chat not found in diagnostics. Found title: " + title }) }] };
                    }
                }

                if (name === 'send_prompt') {
                    const prompt = (request.params.arguments as any).prompt;
                    await vscode.commands.executeCommand('antigravity.agentSidePanel.focus');
                    await new Promise(r => setTimeout(r, 500));
                    await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
                    return { content: [{ type: 'text', text: 'Prompt queued successfully' }] };
                }

                if (name === 'start_new_chat') {
                    const prompt = (request.params.arguments as any)?.prompt;
                    await vscode.commands.executeCommand('antigravity.startNewConversation');
                    if (prompt) {
                        await new Promise(r => setTimeout(r, 800));
                        await vscode.commands.executeCommand('antigravity.agentSidePanel.focus');
                        await new Promise(r => setTimeout(r, 300));
                        await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
                    }
                    return { content: [{ type: 'text', text: 'New chat initiated' }] };
                }

                throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            });
        }

        // --- SSE ENDPOINTS ---
        let transports: Map<string, SSEServerTransport> = new Map();

        app.get('/sse', async (req, res) => {
            const transport = new SSEServerTransport('/message', res);
            transports.set(transport.sessionId, transport);

            res.on('close', () => {
                transports.delete(transport.sessionId);
            });

            const localServer = new Server({
                name: 'antigravity-mcp-experimental',
                version: '1.0.0'
            }, {
                capabilities: { tools: {} }
            });

            localServer.onerror = (error) => {
                outputChannel.appendLine(`[MCP Server Error] (Session: ${transport.sessionId}): ${error}`);
            };

            transport.onerror = (error) => {
                outputChannel.appendLine(`[MCP Transport Error] (Session: ${transport.sessionId}): ${error}`);
            };

            setupHandlers(localServer);

            try {
                await localServer.connect(transport);
            } catch (e: any) {
                outputChannel.appendLine(`[Server] SSE connect error: ${e.message}`);
            }
        });

        app.post('/message', async (req, res) => {
            const sid = req.query.sessionId as string;
            const transport = sid ? transports.get(sid) : undefined;
            if (transport) {
                try {
                    await transport.handlePostMessage(req, res);
                } catch (err: any) {
                    outputChannel.appendLine(`[MCP Transport Error] POST /message failed (Session: ${sid}): ${err.message}`);
                    if (!res.headersSent) {
                        res.status(500).send(err.message);
                    }
                }
            } else {
                outputChannel.appendLine(`[Express] Rejected POST /message - missing or invalid sessionId: ${sid}`);
                res.status(400).send('SSE transport not initialized or session invalid');
            }
        });

        // Global express error handler
        app.use((err: any, req: any, res: any, next: any) => {
            outputChannel.appendLine(`[Express Error] Route ${req.path} failed: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).send('Internal Server Error');
            }
        });

        // --- DASHBOARD API ROUTES ---
        app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Content-Type');
            if (req.method === 'OPTIONS') return res.sendStatus(204);
            next();
        });

        app.get('/history', async (req, res) => {
            try {
                const cdpHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('cdpHost') || 'localhost';
                const cdpPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('cdpPort') || 9222;
                const dashboardHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('host') || 'localhost';
                const dashboardPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('port') || 3033;

                const rawJson = await vscode.commands.executeCommand('antigravity.getDiagnostics');
                let diag: any = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;

                let currentSession: any = { id: "-", title: "-", messages: 0, is_focused: false, telemetry: null };
                let allChats: any[] = [];

                const now = Date.now();
                if (now - lastSnifferTime > SNIFFER_THROTTLE_MS) {
                    cachedSnifferRes = await fetchChatDOM(cdpHost, cdpPort, dashboardHost, dashboardPort);
                    lastSnifferTime = now;
                }

                let snifferTitle = cachedSnifferRes?.chatTitle;
                let snifferSessionId = cachedSnifferRes?.sessionId;

                if (diag.recentTrajectories && diag.recentTrajectories.length > 0) {
                    let focusedTrajectory = null;
                    if (snifferSessionId) {
                        focusedTrajectory = diag.recentTrajectories.find((t: any) => t.googleAgentId === snifferSessionId);
                    }
                    if (!focusedTrajectory && snifferTitle) {
                        const cleanMatch = snifferTitle.trim().toLowerCase();
                        if (cleanMatch.length > 0 && !["new chat", "agent", "customization"].includes(cleanMatch)) {
                            focusedTrajectory = diag.recentTrajectories.find((t: any) => (t.summary || "").trim().toLowerCase() === cleanMatch);
                        }
                    }

                    let displaySession = focusedTrajectory || diag.recentTrajectories[0];
                    let isVirtual = !focusedTrajectory && (snifferTitle || snifferSessionId);

                    currentSession = {
                        id: (isVirtual ? snifferSessionId : displaySession.googleAgentId) || "-",
                        title: (isVirtual ? snifferTitle : displaySession.summary) || "Unknown Session",
                        messages: isVirtual ? 0 : (displaySession.lastStepIndex || 0),
                        is_focused: !!(focusedTrajectory || isVirtual),
                        telemetry: isVirtual ? null : displaySession
                    };

                    allChats = diag.recentTrajectories.map((t: any) => ({
                        id: t.googleAgentId || "Unknown",
                        title: t.summary || "No Title",
                        messages: t.lastStepIndex || 0,
                        is_focused: currentSession.id === t.googleAgentId,
                        telemetry: t
                    }));
                }

                res.json({
                    current_session: currentSession,
                    all_chats: allChats,
                    sniffer_title: snifferTitle,
                    sniffer_sid: snifferSessionId
                });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        app.get('/agent/dom', async (req, res) => {
            try {
                const cdpHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('cdpHost') || 'localhost';
                const cdpPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('cdpPort') || 9222;
                const dashboardHost = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('host') || 'localhost';
                const dashboardPort = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('port') || 3033;
                const now = Date.now();
                if (now - lastSnifferTime > SNIFFER_THROTTLE_MS || !cachedSnifferRes) {
                    cachedSnifferRes = await fetchChatDOM(cdpHost, cdpPort, dashboardHost, dashboardPort);
                    lastSnifferTime = now;
                }
                res.json(cachedSnifferRes);
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        app.post('/agent/prompt', express.json(), async (req, res) => {
            try {
                const prompt = req.body.text || req.body.prompt;
                if (!prompt) throw new Error("Missing prompt");
                outputChannel.appendLine(`[Dashboard] Focusing Active Tab...`);
                await vscode.commands.executeCommand('antigravity.agentSidePanel.focus');
                setTimeout(async () => {
                    try {
                        outputChannel.appendLine(`[Dashboard] Injecting prompt: ${prompt.substring(0, 30)}...`);
                        await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
                    } catch (err: any) {
                        outputChannel.appendLine(`Injection Error: ${err.message}`);
                    }
                }, 500);
                res.json({ status: "Prompt injection initiated" });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        app.post('/agent/accept', async (req, res) => {
            try {
                await vscode.commands.executeCommand('antigravity.acceptAgentStep');
                res.json({ status: "Accepted" });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        app.post('/new-chat', async (req, res) => {
            try {
                outputChannel.appendLine(`[Dashboard] Starting New Conversation...`);
                await vscode.commands.executeCommand('antigravity.startNewConversation');
                res.json({ status: "New chat started" });
            } catch (e: any) {
                res.status(500).json({ error: e.message });
            }
        });

        app.get('/', (req, res) => {
            res.send(getDashboardHtml());
        });

        const port = vscode.workspace.getConfiguration('antigravity-mcp').get<number>('port') || 3033;
        const host = vscode.workspace.getConfiguration('antigravity-mcp').get<string>('host') || 'localhost';

        expressServer = app.listen(port, host, () => {
            const msg = `Antigravity MCP & Bridge is running on http://${host}:${port}`;
            vscode.window.showInformationMessage(msg);
            outputChannel.appendLine(`[Server] ${msg}`);
        });
    });

    const stopCmd = vscode.commands.registerCommand('antigravity-mcp.stopServer', () => {
        if (expressServer) {
            expressServer.close();
            expressServer = null;
            serverInstance = null;
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

function getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Antigravity Bridge / MCP Server</title>
    <style>
        :root { --bg: #0f172a; --card: #1e293b; --accent: #38bdf8; --text: #f1f5f9; --green: #22c55e; --purple: #a855f7; }
        body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); display: flex; flex-direction: column; align-items: center; padding: 2rem; margin: 0; min-height: 100vh; }
        .container { width: 100%; max-width: 900px; }
        .card { background: var(--card); border-radius: 12px; padding: 1.5rem; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3); margin-bottom: 1.2rem; border: 1px solid #334145; transition: transform 0.2s; }
        .card:hover { transform: translateY(-2px); }
        h1 { color: var(--accent); margin-top: 0; font-size: 1.4rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; display: flex; justify-content: space-between; align-items: center; }
        .rev { font-size: 0.8rem; background: #38bdf822; padding: 4px 10px; border-radius: 100px; color: var(--accent); font-weight: bold; }
        textarea { width: 100%; border-radius: 6px; padding: 1rem; background: #0f172a; color: white; border: 1px solid #334155; height: 100px; margin: 1rem 0; box-sizing: border-box; font-family: inherit; font-size: 1rem; resize: vertical; }
        .btn { border: none; padding: 0.8rem 1.2rem; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; transition: all 0.2s; background: var(--accent); color: #0f172a; }
        .btn:active { transform: scale(0.98); }
        .btn-green { background: var(--green); color: #0f172a; }
        .btn-purple { background: var(--purple); color: white; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 1rem; }
        .status-bar { display: flex; flex-direction: column; gap: 0.5rem; background: #011627; border: 1px solid #1e293b; padding: 1rem; border-radius: 8px; margin-top: 1rem; font-family: 'Fira Code', monospace; font-size: 0.9rem; }
        .status-row { display: flex; justify-content: space-between; }
        .status-item { opacity: 0.9; }
        .status-val { font-weight: bold; color: var(--green); }
        .focused-indicator { background: var(--green); color: #0f172a; font-size: 0.65rem; padding: 2px 6px; border-radius: 4px; margin-left: 8px; vertical-align: middle; }
        .chat-list { list-style: none; padding: 0; margin: 0; max-height: 200px; overflow-y: auto; font-size: 0.85rem; }
        .chat-li { padding: 0.6rem 0; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
        .chat-li:last-child { border-bottom: none; }
        .chat-info { flex: 1; }
        .chat-id { opacity: 0.5; font-size: 0.7rem; font-family: monospace; }
        .debug-panel { margin-top: 1rem; padding: 0.8rem; background: #ef444411; border: 1px solid #ef444433; border-radius: 6px; font-size: 0.75rem; color: #fca5a5; }
        .modal-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(4px); display: flex; justify-content: center; align-items: center; z-index: 1000; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
        .modal-overlay.active { opacity: 1; pointer-events: auto; }
        .modal-content { width: 90%; max-width: 800px; height: 85vh; display: flex; flex-direction: column; position: relative; margin: 0; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 0.8rem; margin-bottom: 1rem; }
        .modal-header h2 { margin: 0; font-size: 1.2rem; color: var(--purple); }
        .close-btn { background: none; border: none; color: var(--text); font-size: 1.5rem; cursor: pointer; padding: 0 0.5rem; }
        .telemetry-pre { background: #011627; padding: 1rem; border-radius: 8px; border: 1px solid #1e293b; overflow: auto; flex: 1; font-size: 0.85rem; line-height: 1.4; color: #a5d6ff; margin: 0; font-family: 'Fira Code', monospace; }
        .telemetry-btn { background: var(--purple); border: none; color: white; border-radius: 4px; padding: 3px 8px; font-size: 0.7rem; cursor: pointer; margin-left: 10px; font-weight: bold; }
        .telemetry-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
    </style>
</head>
<body>
    <div class="container bridge-dashboard">
        <div class="card">
            <h1>🚤 Antigravity Bridge / MCP <span class="rev">REV 30</span></h1>
            
            <div class="status-bar">
                <div class="status-row">
                    <div class="status-item">Session ID: <span class="status-val" id="bridge-sid">Loading...</span></div>
                    <div class="status-item">Messages: <span class="status-val" id="cnt">-</span></div>
                </div>
                <div class="status-item">Focused Session: <span class="status-val" id="stitle">-</span> <span id="focusBadge" class="focused-indicator" style="display:none;">LIVE FOCUS</span><button id="viewTelemetryBtn" class="telemetry-btn" style="display:none;" onclick="openTelemetry()">👁️ TELEMETRY</button></div>
                <div id="debugInfo" class="debug-panel" style="display:none;"></div>
            </div>

            <textarea id="promptInput" placeholder="Enter task for the FOCUSED chat session..."></textarea>
            
            <div class="grid">
                <button class="btn btn-purple" onclick="newChat()">🧹 Start New Chat</button>
                <button class="btn" onclick="sendPrompt()">⚡ Send to Active Session</button>
            </div>
            <div class="grid">
                <button class="btn btn-green" onclick="exec('/agent/accept')" style="grid-column: 1 / -1;">✅ Accept Plan</button>
            </div>
        </div>

        <div class="card">
            <h3 style="margin-top:0; color:var(--accent); font-size:1rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem;">Active Chats</h3>
            <ul id="chatList" class="chat-list">
                <li class="chat-li">Loading chats...</li>
            </ul>
        </div>

        <div class="card">
            <h3 style="margin-top:0; color:var(--accent); font-size:1rem; border-bottom: 1px solid #334155; padding-bottom: 0.5rem;">Live Agent DOM (CDP)</h3>
            <div id="domOutput" style="font-size:0.8rem; overflow-y:auto; max-height:400px; color:var(--text); background: #0c111c; padding: 1rem; border-radius: 8px; border: 1px solid #1e293b; display: flex; flex-direction: column; gap: 0.8rem;">Waiting for DOM stream...</div>
        </div>
        
        <div id="telemetryModal" class="modal-overlay" onclick="if(event.target===this) closeTelemetry()">
            <div class="card modal-content" onclick="event.stopPropagation()">
                <div class="modal-header">
                    <h2>📊 JSON Telemetry Data</h2>
                    <button class="close-btn" onclick="closeTelemetry()">&times;</button>
                </div>
                <pre id="telemetryData" class="telemetry-pre">Loading...</pre>
            </div>
        </div>
    </div>

    <script>
        let lastSid = null;
        let currentTelemetry = null;
        window.allChatsData = [];

        function openTelemetry() {
            const modal = document.getElementById('telemetryModal');
            const dataEl = document.getElementById('telemetryData');
            dataEl.textContent = currentTelemetry ? JSON.stringify(currentTelemetry, null, 2) : "No telemetry data provided inside diagnostics for this session.";
            modal.classList.add('active');
        }

        function openTelemetryForChat(id) {
            const chat = window.allChatsData.find(c => c.id === id);
            if (chat && chat.telemetry) {
                const modal = document.getElementById('telemetryModal');
                const dataEl = document.getElementById('telemetryData');
                dataEl.textContent = JSON.stringify(chat.telemetry, null, 2);
                modal.classList.add('active');
            }
        }

        function closeTelemetry() {
            document.getElementById('telemetryModal').classList.remove('active');
        }

        async function newChat() {
            try {
                const r = await fetch('/new-chat', { method: 'POST' });
                console.log(await r.json());
            } catch (e) { alert(e.message); }
        }

        async function sendPrompt() {
            const text = document.getElementById('promptInput').value;
            try {
                const r = await fetch('/agent/prompt', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text })
                });
                console.log(await r.json());
            } catch (e) { alert(e.message); }
        }

        async function exec(url) {
            try {
                const r = await fetch(url, { method: 'POST' });
                console.log(await r.json());
            } catch (e) { alert(e.message); }
        }

        function escapeHTML(str) {
            if(!str) return "";
            return str.replace(/[&<>'"]/g, tag => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
            }[tag]));
        }

        async function pollHistory() {
            try {
                const r = await fetch('/history');
                const data = await r.json();
                
                const currentSid = data.current_session.id;
                document.getElementById('bridge-sid').innerText = currentSid;
                document.getElementById('cnt').innerText = data.current_session.messages;
                document.getElementById('stitle').innerText = data.current_session.title;
                
                if (lastSid && lastSid !== currentSid) {
                    document.getElementById('promptInput').value = '';
                }
                lastSid = currentSid;
                
                const badge = document.getElementById('focusBadge');
                badge.style.display = data.current_session.is_focused ? 'inline-block' : 'none';

                currentTelemetry = data.current_session.telemetry;
                document.getElementById('viewTelemetryBtn').style.display = currentTelemetry ? 'inline-block' : 'none';

                const debug = document.getElementById('debugInfo');
                if ((data.sniffer_title || data.sniffer_sid) && !data.current_session.is_focused) {
                    debug.style.display = 'block';
                    debug.innerHTML = '<b>Mismatch Debug:</b><br>' + 
                                     'Sniffer Title: "' + (data.sniffer_title || "None") + '"<br>' +
                                     'Sniffer ID: "' + (data.sniffer_sid || "None") + '"<br>';
                } else {
                    debug.style.display = 'none';
                }

                window.allChatsData = data.all_chats || [];
                const list = document.getElementById('chatList');
                list.innerHTML = '';
                data.all_chats.forEach(chat => {
                    const li = document.createElement('li');
                    li.className = 'chat-li';
                    const focusStyle = chat.is_focused ? 'border-left: 4px solid var(--green); padding-left: 10px; background: #22c55e0a;' : '';
                    li.style = focusStyle;
                    li.innerHTML = '<div class="chat-info" style="display:flex; justify-content:space-between; align-items:center;">' + 
                                   '<div><strong style="color:var(--green); min-width: 60px; display: inline-block;">' + chat.messages + ' msg</strong>' + 
                                   '<span style="color:var(--text)">' + escapeHTML(chat.title) + '</span>' + 
                                   (chat.is_focused ? ' <span class="focused-indicator">FOCUSED</span>' : '') +
                                   '<br><span class="chat-id">' + chat.id + '</span></div>' +
                                   '<button class="telemetry-btn" title="View Telemetry" onclick="openTelemetryForChat(\\'' + chat.id + '\\')">👁️</button></div>';
                    list.appendChild(li);
                });
            } catch (e) { console.error("Poll Error:", e); }

            try {
                const rDom = await fetch('/agent/dom');
                const domData = await rDom.json();
                const outE = document.getElementById('domOutput');
                const isNearBottom = outE.scrollHeight - outE.clientHeight <= outE.scrollTop + 50;

                if (domData.error) {
                    outE.innerHTML = "<div style='color:#ef4444'>CDP Error: " + escapeHTML(domData.error) + "</div>";
                } else if (domData.parsed && domData.parsed.length > 0) {
                    let lastPromptIdx = -1;
                    for (let i = domData.parsed.length - 1; i >= 0; i--) {
                        if (domData.parsed[i].type === 'prompt') {
                            lastPromptIdx = i;
                            break;
                        }
                    }
                    
                    const latestMsgs = lastPromptIdx !== -1 ? domData.parsed.slice(lastPromptIdx) : domData.parsed.slice(-2);
                    
                    let html = '<div style="text-align: center; margin-bottom: 0.5rem;"><span style="background: rgba(56, 189, 248, 0.1); color: var(--accent); padding: 4px 12px; border-radius: 20px; font-size: 0.7rem; font-weight: bold; border: 1px solid rgba(56, 189, 248, 0.2);">✨ LATEST EXCHANGE</span></div>';
                    
                    latestMsgs.forEach(msg => {
                        let safeText = escapeHTML(msg.text);

                        if (msg.type === 'prompt') {
                            html += '<div style="background:var(--card); align-self: flex-end; max-width: 85%; padding: 0.8rem 1rem; border-radius: 12px 12px 0 12px; border: 1px solid rgba(56, 189, 248, 0.3); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">' +
                                    '<div style="color:var(--accent); font-weight:bold; margin-bottom:6px; font-size:0.75rem; display:flex; align-items:center; gap:5px;"><span>👤</span> YOU</div>' + 
                                    '<div style="margin:0; white-space:pre-wrap; font-family:inherit; line-height: 1.5; font-size: 0.9rem;">' + safeText + '</div></div>';
                        } else {
                            html += '<div style="background:linear-gradient(145deg, #011627 0%, #0a192f 100%); align-self: flex-start; max-width: 90%; padding: 0.8rem 1rem; border-radius: 12px 12px 12px 0; border: 1px solid rgba(34, 197, 94, 0.2); box-shadow: 0 4px 10px rgba(0,0,0,0.15);">' +
                                    '<div style="color:var(--green); font-weight:bold; margin-bottom:6px; font-size:0.75rem; display:flex; align-items:center; gap:5px;"><span>🤖</span> AI ' + (msg.header && msg.header !== 'AI' ? '<span style="opacity:0.6; font-weight:normal; font-size:0.65rem;">(' + escapeHTML(msg.header) + ')</span>' : '') + '</div>' + 
                                    '<div style="margin:0; white-space:pre-wrap; font-family:inherit; opacity:0.9; line-height:1.5; font-size: 0.9rem;">' + safeText + '</div></div>';
                        }
                    });
                    
                    outE.innerHTML = html;
                    if (isNearBottom) outE.scrollTop = outE.scrollHeight;
                } else {
                    outE.innerHTML = "<div style='opacity: 0.5; text-align: center; padding: 2rem;'>Chat is empty or loading...</div>";
                }
            } catch (e) { console.error("DOM Poll Error:", e); }

            setTimeout(pollHistory, 500);
        }

        pollHistory();
    </script>
</body>
</html>`;
}
