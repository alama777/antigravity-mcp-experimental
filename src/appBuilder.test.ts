import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createExpressApp, AppContext } from './appBuilder';

describe('appBuilder (Express Server)', () => {
    let mockCtx: AppContext;
    let app: any;

    beforeEach(() => {
        mockCtx = {
            getConfig: vi.fn((key: string) => {
                if (key === 'port') return 1234;
                if (key === 'host') return 'localhost';
                return undefined;
            }),
            executeCommand: vi.fn().mockResolvedValue(null),
            log: vi.fn()
        };
        app = createExpressApp(mockCtx);
    });

    it('should return HTML dashboard on GET /', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<!DOCTYPE html>');
        expect(res.text).toContain('Antigravity Bridge / MCP Server');
    });

    it('should call antigravity.startNewConversation on POST /new-chat', async () => {
        const res = await request(app).post('/new-chat');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'New chat started' });
        
        expect(mockCtx.executeCommand).toHaveBeenCalledWith('antigravity.startNewConversation');
        expect(mockCtx.log).toHaveBeenCalledWith(expect.stringContaining('Starting New Conversation'));
    });

    it('should call antigravity.acceptAgentStep on POST /agent/accept', async () => {
        const res = await request(app).post('/agent/accept');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'Accepted' });
        
        expect(mockCtx.executeCommand).toHaveBeenCalledWith('antigravity.acceptAgentStep');
    });

    it('should return 400 for POST /message without valid sessionId', async () => {
        const res = await request(app).post('/message');
        expect(res.status).toBe(400);
        expect(res.text).toContain('SSE transport not initialized');
    });
});
