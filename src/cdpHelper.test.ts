import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanHtml, fetchChatDOM } from './cdpHelper';

// Эмулируем библиотеку WebSockets, так как fetchChatDOM пытается создать реальное соединение
const mockWsOn = vi.fn();
vi.mock('ws', () => {
    return {
        default: class WebSocketMock {
            readyState = 1; // OPEN
            on = mockWsOn;
            send() {}
            close() {}
        }
    };
});

describe('cdpHelper', () => {
    describe('cleanHtml', () => {
        it('should strip style tags completely', () => {
            const input = '<div>Hello <style>body { color: red; }</style>World</div>';
            expect(cleanHtml(input)).toBe('Hello World');
        });

        it('should replace HTML tags with newlines and trim extra whitespace', () => {
            const input = '<ul><li>Item 1</li><li>Item 2</li></ul>';
            expect(cleanHtml(input)).toBe('Item 1\n\nItem 2');
        });

        it('should handle empty or null strings', () => {
            expect(cleanHtml('')).toBe('');
            expect(cleanHtml(null as any)).toBe('');
        });
    });

    describe('fetchChatDOM', () => {
        beforeEach(() => {
            vi.restoreAllMocks();
            mockWsOn.mockReset();
        });

        it('should return error if CDP connection fails', async () => {
            global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
            
            const result = await fetchChatDOM('localhost', 9222);
            expect(result.error).toContain('Connection failed');
        });

        it('should return empty if no chat session detected', async () => {
            global.fetch = vi.fn().mockResolvedValue({
                json: async () => [{ type: 'other', url: 'about:blank' }]
            });

            const result = await fetchChatDOM('localhost', 9222);
            expect(result.sessionId).toBeNull();
            expect(result.error).toContain('not detected');
        });

        it('should correctly parse HTML from Antigravity CDP target', async () => {
            // Имитируем, что fetch нашел веб-вью (WebView)
            global.fetch = vi.fn().mockResolvedValue({
                json: async () => [{ type: 'webview', url: 'workbench.html', webSocketDebuggerUrl: 'ws://mock-url' }]
            });

            // Настроим мок WebSocket, чтобы он сразу же вернул нам готовые, "сырые" данные чата
            mockWsOn.mockImplementation((event, callback) => {
                if (event === 'open') {
                    setTimeout(callback, 0); // Имитация коннекта
                }
                if (event === 'message') {
                    const mockPanelHTML = `
                        <div>
                            <div class="test-class text-ellipsis whitespace-nowrap gap-1">My Test Chat</div>
                            <div data-tooltip-id="copy-123">
                                content_copy
                                What is the weather?
                            </div>
                            <div role="button" data-tooltip-id="undo-123">
                                undo
                                Thought for 10s
                                It is sunny!
                                exit_to_app
                            </div>
                            <div id="antigravity.agentSidePanelInputBox"></div>
                        </div>
                    `;

                    setTimeout(() => {
                        callback(JSON.stringify({
                            id: 1,
                            result: {
                                result: {
                                    value: {
                                        sessionId: 'mock-session-123',
                                        panelData: { html: mockPanelHTML }
                                    }
                                }
                            }
                        }));
                    }, 0);
                }
            });

            const result = await fetchChatDOM('localhost', 9222);

            // Проверяем, что парсер не сломался и успешно вытащил все метаданные
            expect(result.error).toBeUndefined();
            expect(result.sessionId).toBe('mock-session-123');
            expect(result.chatTitle).toBe('My Test Chat');
            
            // Проверяем, что парсер разбил диалог на нужные куски и "заголовки"
            expect(result.parsed).toHaveLength(2);
            expect(result.parsed[0]).toEqual({
                type: 'prompt',
                text: 'What is the weather?'
            });
            expect(result.parsed[1]).toEqual({
                type: 'agent',
                header: 'Thought for 10s',
                text: 'It is sunny!'
            });
        });
    });
});
