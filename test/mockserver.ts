import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import type { MockServerClient } from 'mockserver-client';

const require = createRequire(import.meta.url);
const { runBinary } = require('mockserver-node/downloadBinary') as { runBinary: (version: string, args: string[]) => Promise<ChildProcess> };
const { version } = require('mockserver-node/package.json') as { version: string };
const { mockServerClient } = require('mockserver-client') as { mockServerClient: (host: string, port: number) => MockClient };

export interface RecordedRequest {
    path: string;
    headers: Record<string, string[]>;
    body: { string: string; xml?: string; json: Record<string, string> };
}

export const entryUpdate = (request: RecordedRequest) => JSON.parse(request.body.string) as { entry_ids: number[]; status: string };

export type MockClient = Omit<MockServerClient, 'retrieveRecordedRequests'> & {
    retrieveRecordedRequests: (request: { method?: string; path?: string }) => Promise<RecordedRequest[] | undefined>;
};

export const createClient = (port: number): MockClient => mockServerClient('localhost', port);

export const startServer = async (port: number) => {
    const proc = await runBinary(version, ['run', '-p', String(port)]);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        const ready = await fetch(`http://localhost:${port}/mockserver/status`, { method: 'PUT' }).then(res => res.ok, () => false);
        if (ready) return proc;
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`MockServer on port ${port} did not start within 60s`);
};

export const waitFor = async (client: MockClient, method: string, path: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const requests: RecordedRequest[] = (await client.retrieveRecordedRequests({ method, path })) ?? [];
        if (requests.length > 0) return requests[0];
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`timed out after ${ms}ms`);
};

export const eventually = async <T>(check: () => T | Promise<T>, ms = 10000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            return await check();
        } catch (err) {
            if (Date.now() >= deadline) throw err;
            await new Promise(r => setTimeout(r, 100));
        }
    }
};

export const json = (method: string, path: string, statusCode: number, body: object) => ({
    httpRequest: { method, path },
    httpResponse: {
        statusCode,
        headers: [{ name: 'Content-Type', values: ['application/json'] }],
        body: JSON.stringify(body),
    },
});

export const waitForCount = async (client: MockClient, method: string, path: string, count: number, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const requests: RecordedRequest[] = (await client.retrieveRecordedRequests({ method, path })) ?? [];
        if (requests.length >= count) return requests;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`timed out after ${ms}ms`);
};
