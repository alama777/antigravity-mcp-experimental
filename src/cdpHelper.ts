import WebSocket from 'ws';
import * as vscode from 'vscode';

function cleanHtml(h: string): string {
    if (!h) return "";
    return h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, '\n')
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            .trim();
}

export interface ChatDOMResult {
    sessionId: string | null;
    chatTitle: string | null;
    parsed: Array<{ type: string; text: string; header?: string }>;
    error?: string;
}

export async function fetchChatDOM(cdpHost: string, cdpPort: number, dashboardHost: string = 'localhost', dashboardPort: number = 3033): Promise<ChatDOMResult> {
    let targets: any[];
    try {
        const response = await fetch(`http://${cdpHost}:${cdpPort}/json`);
        targets = await response.json() as any[];
    } catch (e: any) {
        return { sessionId: null, chatTitle: null, parsed: [], error: "CDP Connection failed: " + e.message };
    }

    // Prioritize webviews over main workbench
    const sortedTargets = targets.sort((a, b) => {
        if (a.url.includes('workbench.html')) return 1;
        if (b.url.includes('workbench.html')) return -1;
        return 0;
    });

    for (const t of sortedTargets) {
        if (t.type !== 'page' && t.type !== 'webview') continue;
        
        // Skip our own dashboard if it's open in browser/webview
        if (t.url.includes(`${dashboardHost}:${dashboardPort}`) || (t.title && t.title.includes('MCP Server'))) continue;

        const data: any = await executeCdpTarget(t.webSocketDebuggerUrl, dashboardHost, dashboardPort);
        
        if (data && (data.sessionId || data.panelData)) {
            // Found the chat!
            let result: ChatDOMResult = { 
                sessionId: data.sessionId || null,
                chatTitle: null,
                parsed: []
            };

            if (data.panelData) {
                const html = data.panelData.html;
                
                const titleMatch = html.match(/class="[^"]*text-ellipsis whitespace-nowrap gap-1[^"]*">([^<]+)<\/div>/);
                if (titleMatch && titleMatch[1]) {
                    result.chatTitle = titleMatch[1].trim();
                }

                // Restore complex parsing logic
                let chatInputIdx = html.lastIndexOf('<div id="antigravity.agentSidePanelInputBox"');
                if (chatInputIdx === -1) chatInputIdx = html.length;
                let htmlUpToInput = html.substring(0, chatInputIdx);

                let htmlUpToMerge = htmlUpToInput;
                let mergeMarker = '<div data-tooltip-id="merge-';
                let mergeIdx = htmlUpToMerge.lastIndexOf(mergeMarker);
                if (mergeIdx !== -1) {
                    htmlUpToMerge = htmlUpToMerge.substring(0, mergeIdx);
                }
                
                let undoMarker = '<div role="button" data-tooltip-id="undo-';
                let undoIdx = htmlUpToMerge.lastIndexOf(undoMarker);
                
                if (undoIdx !== -1) {
                    let aiHtml = htmlUpToMerge.substring(undoIdx);
                    let htmlUpToUndo = htmlUpToMerge.substring(0, undoIdx);
                    
                    let copyMarker = '<div data-tooltip-id="copy-';
                    let copyIdx = htmlUpToUndo.lastIndexOf(copyMarker);
                    
                    let promptHtml = "";
                    let isFirst = false;
                    if (copyIdx !== -1) {
                        promptHtml = htmlUpToUndo.substring(copyIdx);
                    } else {
                        promptHtml = htmlUpToUndo;
                        isFirst = true;
                    }

                    // Clean AI text
                    let aiTextRaw = cleanHtml(aiHtml);
                    
                    let exitIdx = aiTextRaw.lastIndexOf('exit_to_app');
                    if (exitIdx !== -1) {
                        aiTextRaw = aiTextRaw.substring(0, exitIdx).trim();
                    }
                    
                    let aiLines = aiTextRaw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                    
                    if (aiLines.length > 0 && aiLines[0] === 'undo') {
                        aiLines.shift();
                    }
                    
                    let aiHeader = "AI";
                    if (aiLines.length > 0 && (aiLines[0].startsWith('Worked for') || aiLines[0].startsWith('Thought for'))) {
                        aiHeader = aiLines.shift()!;
                    }
                    
                    let aiText = aiLines.join('\n').trim();
                    
                    // Clean Prompt
                    let promptTextRaw = cleanHtml(promptHtml);
                    let pLines = promptTextRaw.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
                    
                    if (pLines.length > 0 && (pLines[0] === 'content_copy' || pLines[0] === 'edit_square')) {
                        pLines.shift();
                    }
                    
                    if (isFirst && pLines.length > 0) {
                        if (!result.chatTitle) result.chatTitle = pLines[0];
                        pLines.shift();
                    }

                    promptTextRaw = pLines.join('\n').trim();

                    result.parsed.push({ type: 'prompt', text: promptTextRaw });
                    result.parsed.push({ type: 'agent', header: aiHeader, text: aiText });
                }
            }
            
            return result;
        }
    }

    return { sessionId: null, chatTitle: null, parsed: [], error: "Chat session not detected in any CDP target" };
}

function executeCdpTarget(wsUrl: string, dashboardHost: string, dashboardPort: number): Promise<any> {
    return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            const expression = `
                (() => {
                    // Isolation: Never look at our own dashboard
                    if (window.location.href.includes('${dashboardHost}:${dashboardPort}')) return null;
                    if (document.title.includes('MCP Server') || document.title.includes('Bridge')) return null;

                    try {
                        const panel = document.querySelector('.antigravity-agent-side-panel, #antigravity-agent-manager');
                        if (panel) {
                            return {
                                panelData: {
                                    html: panel.outerHTML,
                                    text: panel.innerText
                                }
                            };
                        }

                        // Fallback to iframes/webviews
                        for (const frame of document.querySelectorAll('iframe, webview')) {
                            try {
                                if (frame.contentWindow && frame.contentWindow.document) {
                                    const innerPanel = frame.contentWindow.document.querySelector('.antigravity-agent-side-panel, #antigravity-agent-manager');
                                    if (innerPanel) {
                                        return {
                                            panelData: {
                                                html: innerPanel.outerHTML,
                                                text: innerPanel.innerText
                                            }
                                        };
                                    }
                                }
                            } catch(e) {}
                        }
                        return null;
                    } catch (e) { return null; }
                })()
            `;
            
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression, returnByValue: true }
            }));
        });
        
        ws.on('message', (data: string) => {
            try {
                const msg = JSON.parse(data);
                if (msg.id === 1) {
                    ws.close();
                    if (msg.result && msg.result.result && msg.result.result.value) {
                        resolve(msg.result.result.value);
                    } else {
                        resolve(null);
                    }
                }
            } catch (e) {
                ws.close();
                resolve(null);
            }
        });
        
        ws.on('error', () => resolve(null));
        
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.close();
            resolve(null);
        }, 2000);
    });
}
