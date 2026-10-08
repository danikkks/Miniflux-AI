import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { PROMPT, CATEGORY, FEED, ENTRY, ENTRY_2 } from './fixtures.js';
import { createClient, startServer, waitFor, json } from './mockserver.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROMPT_FILE = resolve(ROOT, PROMPT.filename);

const DB_FILE = resolve(ROOT, 'test-miniflux-ai.db');

const PORT = 18080;
const WEB_PORT = 18081;
const WEB = `http://localhost:${WEB_PORT}`;
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
    DATABASE_PATH: DB_FILE,
    WEB_PORT: String(WEB_PORT),
});

const spawnApp = (env: Record<string, string> = {}) =>
    spawn('node', ['bootstrap.js'], {
        cwd: ROOT,
        env: { ...process.env, ...baseEnv(), ...env },
        stdio: 'pipe',
    });

before(async () => {
    await writeFile(PROMPT_FILE, PROMPT.content);
    mockProcess = await startServer(PORT);
});

beforeEach(async () => {
    if (child && child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    }
    await unlink(DB_FILE).catch(() => {});
    await mock.reset();
});

after(async () => {
    child?.kill();
    await unlink(PROMPT_FILE).catch(() => {});
    await unlink(DB_FILE).catch(() => {});
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

test('entry classified as "no" is stored in sqlite with its decision', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare('select entry_id, title, url, category, decision from decisions').all();
    db.close();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
        { entry_id: ENTRY.id, title: ENTRY.title, url: ENTRY.url, category: CATEGORY.title, decision: 'no' },
    ]);
});

test('entry classified as "yes" is stored in sqlite with its decision', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'yes', done: true }));

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare('select entry_id, decision from decisions').all();
    db.close();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ entry_id: ENTRY.id, decision: 'yes' }]);
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

test('decision api: entry classified as "no" is marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['decision'] }));
    await mock.mockAnyResponse(json('POST', '/v1/systemone', 200, {
        model: 'nimble:latest',
        answers: { relevant: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
    }));

    child = spawnApp({ OLLAMA_DECISION_API: 'true', OLLAMA_MODEL: 'nimble:latest' });
    const req = await waitFor(mock, 'PUT', '/v1/entries');
    const body = JSON.parse(req.body.string);
    assert.deepEqual(body.entry_ids, [ENTRY.id]);
    assert.equal(body.status, 'read');
});

test('decision api: model missing "decision" capability is never marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['completion'] }));

    child = spawnApp({ OLLAMA_DECISION_API: 'true', OLLAMA_MODEL: 'nimble:latest' });
    await waitFor(mock, 'POST', '/api/show');
    await new Promise((r) => setTimeout(r, 300));
    const putRequests: any[] = (await mock.retrieveRecordedRequests({ method: 'PUT', path: '/v1/entries' })) ?? [];
    assert.equal(putRequests.length, 0);
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

test('review ui: marking a decision wrong yields a prompt-tweak text for the category', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');

    const pending = await (await fetch(WEB)).text();
    assert.match(pending, new RegExp(ENTRY.title));

    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['reviewed', String(ENTRY.id)], ['wrong', String(ENTRY.id)]]),
    });
    const prompt = await review.text();
    assert.ok(prompt.includes(PROMPT.content));
    assert.match(prompt, /Wrong decisions \(1\)/);
    assert.match(prompt, /classifier answered: no \| correct answer: yes/);

    const stillPending = await (await fetch(`${WEB}/pending`)).text();
    assert.match(stillPending, new RegExp(ENTRY.title));
    assert.match(stillPending, /name="wrong" value="100" checked/);

    await fetch(`${WEB}/reviewed`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['reviewed', String(ENTRY.id)]]),
    });
    const after = await (await fetch(`${WEB}/pending`)).text();
    assert.doesNotMatch(after, new RegExp(ENTRY.title));
});

test('review ui: decision not marked wrong is reported as correct', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'yes', done: true }));

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');

    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['reviewed', String(ENTRY.id)]]),
    });
    const prompt = await review.text();
    assert.match(prompt, /Wrong decisions \(0\)/);
    assert.match(prompt, /Correct decisions \(1\)/);
});

test('review ui: prompt includes decisions reviewed in earlier rounds', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY, ENTRY_2] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await waitFor(mock, 'PUT', '/v1/entries');

    const post = (path: string, params: string[][]) =>
        fetch(`${WEB}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });

    await post('/review', [['reviewed', String(ENTRY.id)], ['wrong', String(ENTRY.id)]]);
    await post('/reviewed', [['reviewed', String(ENTRY.id)]]);

    const second = await (await post('/review', [['reviewed', String(ENTRY_2.id)]])).text();
    assert.ok(second.includes(ENTRY.title));
    assert.ok(second.includes(ENTRY_2.title));
    assert.match(second, /Wrong decisions \(1\)/);
    assert.match(second, /Correct decisions \(1\)/);
});
