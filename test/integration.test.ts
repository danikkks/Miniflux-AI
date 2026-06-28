import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROMPT, CATEGORY, FEED, ENTRY } from './fixtures.js';
import { createClient, startServer, waitFor, json } from './mockserver.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROMPT_FILE = resolve(ROOT, PROMPT.filename);

const PORT = 18080;
const mock = createClient(PORT);

let mockProcess: any;
let child: any;

const baseEnv = () => ({
    MINIFLUX_URL: `http://localhost:${PORT}`,
    MINIFLUX_AUTH_TOKEN: 'test',
    OLLAMA_BASE_URL: `http://localhost:${PORT}`,
    OLLAMA_MODEL: 'test-model',
    AI_PROVIDER: 'OLLAMA',
    PROCESSING_INTERVAL_SECONDS: '999',
    PROCESSING_BATCH_SIZE: '10',
});

const spawnApp = () =>
    spawn('node', ['bootstrap.js'], {
        cwd: ROOT,
        env: { ...process.env, ...baseEnv() },
        stdio: 'pipe',
    });

before(async () => {
    await writeFile(PROMPT_FILE, PROMPT.content);
    mockProcess = await startServer(PORT);
});

beforeEach(async () => {
    child?.kill();
    await mock.reset();
});

after(async () => {
    child?.kill();
    await unlink(PROMPT_FILE).catch(() => {});
    mockProcess?.kill();
});

test('entry classified as "no" is marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    const req = await waitFor(mock, 'PUT', '/v1/entries');
    const body = JSON.parse(req.body.string);
    assert.deepEqual(body.entry_ids, [ENTRY.id]);
    assert.equal(body.status, 'read');
});

test('entry classified as "yes" is not marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'yes', done: true }));

    child = spawnApp();
    const req = await waitFor(mock, 'PUT', '/v1/entries');
    const body = JSON.parse(req.body.string);
    assert.deepEqual(body.entry_ids, []);
});

test('category without matching prompt - no feeds fetched', async () => {
    const sportsCategory = { id: 2, title: 'Sports News', user_id: 1, hide_globally: false };
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [sportsCategory]));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');
    const feedsRequests: any[] = (await mock.retrieveRecordedRequests({ method: 'GET', path: `/v1/categories/${sportsCategory.id}/feeds` })) ?? [];
    assert.equal(feedsRequests.length, 0);
});
