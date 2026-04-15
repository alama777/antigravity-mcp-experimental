import express from 'express';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { fetchChatDOM } from './cdpHelper';

export interface AppContext {
    getConfig: <T>(key: string) => T | undefined;
    executeCommand: (cmd: string, ...args: any[]) => Promise<any>;
    log: (msg: string) => void;
}

let cachedSnifferRes: any = null;
let lastSnifferTime = 0;
const SNIFFER_THROTTLE_MS = 2000;

export function createExpressApp(ctx: AppContext) {
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
            ctx.log(`[Tool Call] Executing tool: ${name}`);

            const cdpHost = ctx.getConfig<string>('cdpHost') || '127.0.0.1';
            const cdpPort = ctx.getConfig<number>('cdpPort') || 9222;
            const dashboardHost = ctx.getConfig<string>('host') || '127.0.0.1';
            const dashboardPort = ctx.getConfig<number>('port') || 3033;

            if (name === 'get_active_chat') {
                const domData = await fetchChatDOM(cdpHost, cdpPort, dashboardHost, dashboardPort);
                const title = domData.chatTitle || domData.sessionId; // Fallback to sessionId if no title

                let diag: any = null;
                try {
                    diag = await ctx.executeCommand('antigravity.getDiagnostics');
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
                await ctx.executeCommand('antigravity.agentSidePanel.focus');
                await new Promise(r => setTimeout(r, 500));
                await ctx.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
                return { content: [{ type: 'text', text: 'Prompt queued successfully' }] };
            }

            if (name === 'start_new_chat') {
                const prompt = (request.params.arguments as any)?.prompt;
                await ctx.executeCommand('antigravity.startNewConversation');
                if (prompt) {
                    await new Promise(r => setTimeout(r, 800));
                    await ctx.executeCommand('antigravity.agentSidePanel.focus');
                    await new Promise(r => setTimeout(r, 300));
                    await ctx.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
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
            ctx.log(`[MCP Server Error] (Session: ${transport.sessionId}): ${error}`);
        };

        transport.onerror = (error) => {
            ctx.log(`[MCP Transport Error] (Session: ${transport.sessionId}): ${error}`);
        };

        setupHandlers(localServer);

        try {
            await localServer.connect(transport);
        } catch (e: any) {
            ctx.log(`[Server] SSE connect error: ${e.message}`);
        }
    });

    app.post('/message', async (req, res) => {
        const sid = req.query.sessionId as string;
        const transport = sid ? transports.get(sid) : undefined;
        if (transport) {
            try {
                await transport.handlePostMessage(req, res);
            } catch (err: any) {
                ctx.log(`[MCP Transport Error] POST /message failed (Session: ${sid}): ${err.message}`);
                if (!res.headersSent) {
                    res.status(500).send(err.message);
                }
            }
        } else {
            ctx.log(`[Express] Rejected POST /message - missing or invalid sessionId: ${sid}`);
            res.status(400).send('SSE transport not initialized or session invalid');
        }
    });

    // Global express error handler
    app.use((err: any, req: any, res: any, next: any) => {
        ctx.log(`[Express Error] Route ${req.path} failed: ${err.message}`);
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
            const cdpHost = ctx.getConfig<string>('cdpHost') || '127.0.0.1';
            const cdpPort = ctx.getConfig<number>('cdpPort') || 9222;
            const dashboardHost = ctx.getConfig<string>('host') || '127.0.0.1';
            const dashboardPort = ctx.getConfig<number>('port') || 3033;

            const rawJson = await ctx.executeCommand('antigravity.getDiagnostics');
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

            if (diag && diag.recentTrajectories && diag.recentTrajectories.length > 0) {
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
            const cdpHost = ctx.getConfig<string>('cdpHost') || '127.0.0.1';
            const cdpPort = ctx.getConfig<number>('cdpPort') || 9222;
            const dashboardHost = ctx.getConfig<string>('host') || '127.0.0.1';
            const dashboardPort = ctx.getConfig<number>('port') || 3033;
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
            ctx.log(`[Dashboard] Focusing Active Tab...`);
            await ctx.executeCommand('antigravity.agentSidePanel.focus');
            setTimeout(async () => {
                try {
                    ctx.log(`[Dashboard] Injecting prompt: ${prompt.substring(0, 30)}...`);
                    await ctx.executeCommand('antigravity.sendPromptToAgentPanel', prompt);
                } catch (err: any) {
                    ctx.log(`Injection Error: ${err.message}`);
                }
            }, 500);
            res.json({ status: "Prompt injection initiated" });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/agent/accept', async (req, res) => {
        try {
            await ctx.executeCommand('antigravity.acceptAgentStep');
            res.json({ status: "Accepted" });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/new-chat', async (req, res) => {
        try {
            ctx.log(`[Dashboard] Starting New Conversation...`);
            await ctx.executeCommand('antigravity.startNewConversation');
            res.json({ status: "New chat started" });
        } catch (e: any) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/', (req, res) => {
        res.sendFile(path.resolve(__dirname, '..', 'public', 'dashboard.html'));
    });

    return app;
}
