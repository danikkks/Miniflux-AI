import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runBinary } = require('mockserver-node/downloadBinary');
const { version } = require('mockserver-node/package.json');
const { mockServerClient } = require('mockserver-client');

export const createClient = (port: number) => mockServerClient('localhost', port);

export const startServer = async (port: number) => {
    const proc = await runBinary(version, ['run', '-p', String(port)]);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${port}/mockserver/status`, { method: 'PUT' });
            if (res.ok) return proc;
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`MockServer on port ${port} did not start within 60s`);
};

export const waitFor = async (client: any, method: string, path: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const requests: any[] = (await client.retrieveRecordedRequests({ method, path })) ?? [];
        if (requests.length > 0) return requests[0];
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`timed out after ${ms}ms`);
};

export const json = (method: string, path: string, statusCode: number, body: object) => ({
    httpRequest: { method, path },
    httpResponse: {
        statusCode,
        headers: [{ name: 'Content-Type', values: ['application/json'] }],
        body: JSON.stringify(body),
    },
});
