import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, unlink, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { PROMPT, CATEGORY, FEED, ENTRY, ENTRY_2, SUB_CATEGORY, SUB_FEED, ENTRY_3, GROUP_CATEGORY, GROUP_FEED, GROUP_ENTRY_A, GROUP_ENTRY_B, GROUP_SUB_CATEGORY, GROUP_SUB_FEED, GROUP_ENTRY_C, GROUP_DIGEST } from './fixtures.js';
import { createClient, startServer, eventually, json, entryUpdate, type RecordedRequest } from './mockserver.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROMPT_FILE = resolve(ROOT, PROMPT.filename);

const DB_FILE = resolve(ROOT, 'test-miniflux-ai.db');
const LOG_DIR = resolve(ROOT, 'test-logs');

const PORT = 18080;
const WEB_PORT = 18081;
const WEB = `http://localhost:${WEB_PORT}`;
const mock = createClient(PORT);

let mockProcess: ChildProcess | undefined;
let child: ChildProcess | undefined;

const baseEnv = () => ({
    MINIFLUX_URL: `http://localhost:${PORT}`,
    MINIFLUX_AUTH_TOKEN: 'test',
    OLLAMA_BASE_URL: `http://localhost:${PORT}`,
    OLLAMA_MODEL: 'test-model',
    AI_PROVIDER: 'OLLAMA',
    PROCESSING_INTERVAL_SECONDS: '999',
    PROCESSING_BATCH_SIZE: '10',
    DATABASE_PATH: DB_FILE,
    LOG_DIR,
    WEB_PORT: String(WEB_PORT),
    GROUPING_CATEGORIES: 'world news',
    B2_ENDPOINT: `http://localhost:${PORT}`,
    B2_REGION: 'us-west-004',
    B2_BUCKET: 'test-bucket',
    B2_KEY_ID: 'key-id',
    B2_APPLICATION_KEY: 'app-key',
});

const runFinished = (outcome: 'completed' | 'failed' = 'completed') =>
    eventually(async () => {
        assert.match(await (await fetch(`${WEB}/process`)).text(), new RegExp(`processing ${outcome}`));
    });

const recorded = async (method: string, path: string): Promise<RecordedRequest[]> =>
    (await mock.retrieveRecordedRequests({ method, path })) ?? [];

const spawnApp = (env: Record<string, string> = {}) =>
    spawn('node', ['dist/bootstrap.js'], {
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
    await rm(LOG_DIR, { recursive: true, force: true });
    mockProcess?.kill();
});

test('entry classified as "no" is marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();
    const [req] = await recorded('PUT', '/v1/entries');
    const body = entryUpdate(req);
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
    await runFinished();
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
    await runFinished();
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare('select entry_id, decision from decisions').all();
    db.close();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ entry_id: ENTRY.id, decision: 'yes' }]);
});

test('answer with different case and surrounding whitespace is stored as a decision', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: ' No\n', done: true }));

    child = spawnApp();
    await runFinished();
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare('select entry_id, decision from decisions').all();
    db.close();
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ entry_id: ENTRY.id, decision: 'no' }]);
});

test('entry classified as "yes" is not marked as read', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'yes', done: true }));

    child = spawnApp();
    await runFinished();
    const putRequests = await recorded('PUT', '/v1/entries');
    assert.equal(putRequests.length, 0);
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
    await runFinished();
    const [req] = await recorded('PUT', '/v1/entries');
    const body = entryUpdate(req);
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
    await runFinished();
    const putRequests = await recorded('PUT', '/v1/entries');
    assert.equal(putRequests.length, 0);
});

test('category without matching prompt - no feeds fetched', async () => {
    const sportsCategory = { id: 2, title: 'Sports News', user_id: 1, hide_globally: false };
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [sportsCategory]));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });

    child = spawnApp();
    await runFinished();
    const feedsRequests = await recorded('GET', `/v1/categories/${sportsCategory.id}/feeds`);
    assert.equal(feedsRequests.length, 0);
});

test('review ui: marking a decision wrong yields a prompt-tweak text for the category', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();

    const pending = await (await fetch(WEB)).text();
    assert.match(pending, new RegExp(ENTRY.title));

    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([[`verdict-${ENTRY.id}`, 'wrong']]),
    });
    const prompt = await review.text();
    assert.ok(prompt.includes(PROMPT.content));
    assert.match(prompt, /Wrong decisions \(1\)/);
    assert.match(prompt, /classifier answered: no \| correct answer: yes/);

    const stillPending = await (await fetch(`${WEB}/pending`)).text();
    assert.match(stillPending, new RegExp(ENTRY.title));
    assert.match(stillPending, /name="verdict-100" value="wrong" checked/);

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
    await runFinished();
    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([[`verdict-${ENTRY.id}`, 'correct']]),
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
    await runFinished();

    const post = (path: string, params: string[][]) =>
        fetch(`${WEB}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });

    await post('/review', [[`verdict-${ENTRY.id}`, 'wrong']]);
    await post('/reviewed', [['reviewed', String(ENTRY.id)]]);

    const second = await (await post('/review', [[`verdict-${ENTRY_2.id}`, 'correct']])).text();
    assert.ok(second.includes(ENTRY.title));
    assert.ok(second.includes(ENTRY_2.title));
    assert.match(second, /Wrong decisions \(1\)/);
    assert.match(second, /Correct decisions \(1\)/);
});

test('decision api: oversized entry is truncated to fit the 64 KiB request limit', async () => {
    const hugeEntry = { ...ENTRY, content: 'x'.repeat(200_000) };
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [hugeEntry] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['decision'] }));
    await mock.mockAnyResponse(json('POST', '/v1/systemone', 200, {
        model: 'nimble:latest',
        answers: { relevant: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
    }));

    child = spawnApp({ OLLAMA_DECISION_API: 'true', OLLAMA_MODEL: 'nimble:latest' });
    await runFinished();
    const [req] = await recorded('POST', '/v1/systemone');
    const size = Number(req.headers['content-length'][0]);
    assert.ok(size <= 64 * 1024, `request body was ${size} bytes`);
});

test('review ui: subcategories share one prompt with their parent category', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY, SUB_CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${SUB_CATEGORY.id}/feeds`, 200, [SUB_FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${SUB_FEED.id}/entries`, 200, { entries: [ENTRY_3] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();

    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
            [`verdict-${ENTRY.id}`, 'correct'],
            [`verdict-${ENTRY_3.id}`, 'wrong'],
        ]),
    });
    const html = await review.text();
    assert.equal(html.match(/<textarea/g)?.length, 1);
    assert.ok(html.includes(ENTRY.title));
    assert.ok(html.includes(ENTRY_3.title));
    assert.match(html, /<h3>Technology News<\/h3>/);
});

const FEED_PATH = '/test-bucket/grouped.xml';

const DECISION_ENV = { OLLAMA_DECISION_API: 'true', OLLAMA_MODEL: 'nimble:latest', OLLAMA_SUMMARY_MODEL: 'summary-model' };

const decisionAnswer = (noul: number) => ({
    model: 'nimble:latest',
    answers: { relevant: { type: 'noul', noul } },
    usage: { input_tokens: 1, output_tokens: 1 },
});

const mockSummary = () =>
    mock.mockAnyResponse(json('POST', '/api/generate', 200, {
        response: JSON.stringify({ title: 'Generated title', description: 'Generated description' }),
        done: true,
    }));

const mockDecision = async (noul: number) => {
    await mockSummary();
    await mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['decision'] }));
    await mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', body: { type: 'STRING', string: 'digest that covers', subString: true } },
        httpResponse: { statusCode: 200, body: JSON.stringify(decisionAnswer(0.1)) },
    });
    await mock.mockAnyResponse(json('POST', '/v1/systemone', 200, decisionAnswer(noul)));
};

const mockGroupingSetup = async (entries: object[], categories: object[] = [GROUP_CATEGORY], subscribedFeeds: object[] = []) => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, categories));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${GROUP_CATEGORY.id}/feeds`, 200, [GROUP_FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${GROUP_FEED.id}/entries`, 200, { entries }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: FEED_PATH }, httpResponse: { statusCode: 200 } });
    await mock.mockAnyResponse(json('GET', '/v1/feeds', 200, subscribedFeeds));
};

const items = (body: RecordedRequest['body']): string[] => ((body.xml ?? body.string).match(/<item>[\s\S]*?<\/item>/g) ?? []);

test('grouping: articles about the same story are published as one feed item', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_A.url));
    assert.match(published[0], new RegExp(GROUP_ENTRY_B.url));
    assert.match(put.headers['content-type'][0], /rss\+xml/);
});

test('grouping: miniflux refreshes only the feed subscribed to the published file', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B], [GROUP_CATEGORY], [
        { id: 98, feed_url: 'http://example.com/grouped.xml' },
        { id: 99, feed_url: `http://localhost:${PORT}${FEED_PATH}` },
    ]);
    await mockDecision(0.9);
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/feeds/.*/refresh' }, httpResponse: { statusCode: 204 } });

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const all: RecordedRequest[] = (await mock.retrieveRecordedRequests({})) ?? [];
    const paths = all.map((r) => r.path);
    assert.ok(paths.indexOf(FEED_PATH) < paths.indexOf('/v1/feeds/99/refresh'));
    assert.ok(!paths.includes('/v1/feeds/98/refresh'));
});

test('grouping: articles about different stories are published as separate feed items', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.1);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 2);
    const guids = published.map((i) => i.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1]);
    assert.equal(new Set(guids).size, 2);
});

test('grouping: grouped articles are marked as read in miniflux', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const reads = await recorded('PUT', '/v1/entries');
    const bodies = reads.map((r) => entryUpdate(r));
    assert.deepEqual(bodies.flatMap((b) => b.entry_ids).sort(), [GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
    assert.ok(bodies.every((b) => b.status === 'read'));
});

test('grouping: article is added to a group stored by a previous run', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A]);
    await mockDecision(0.9);
    child = spawnApp(DECISION_ENV);
    await runFinished();
    const exited = once(child, 'exit');
    child.kill();
    await exited;

    await mock.reset();
    await mockGroupingSetup([GROUP_ENTRY_B]);
    await mockDecision(0.9);
    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_A.url));
    assert.match(published[0], new RegExp(GROUP_ENTRY_B.url));
});

test('grouping and filtering run side by side', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B], [CATEGORY, GROUP_CATEGORY]);
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', body: { type: 'STRING', string: 'same news story', subString: true } },
        httpResponse: { statusCode: 200, body: JSON.stringify(decisionAnswer(0.9)) },
    });
    await mockDecision(0.1);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const reads = await recorded('PUT', '/v1/entries');
    const readIds = reads.flatMap((r) => entryUpdate(r).entry_ids).sort();
    assert.deepEqual(readIds, [ENTRY.id, GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
    const [put] = await recorded('PUT', FEED_PATH);
    assert.equal(items(put.body).length, 1);
});

test('grouping: nothing is published when the decision api is turned off', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'yes', done: true }));

    child = spawnApp();
    await runFinished();
    const feedPuts = await recorded('PUT', FEED_PATH);
    const generates = await recorded('POST', '/api/generate');
    assert.equal(feedPuts.length, 0);
    assert.equal(generates.length, 0);
});

test('grouping: subcategory articles are grouped together with their parent category', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A], [GROUP_CATEGORY, GROUP_SUB_CATEGORY]);
    await mock.mockAnyResponse(json('GET', `/v1/categories/${GROUP_SUB_CATEGORY.id}/feeds`, 200, [GROUP_SUB_FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${GROUP_SUB_FEED.id}/entries`, 200, { entries: [GROUP_ENTRY_C] }));
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_A.url));
    assert.match(published[0], new RegExp(GROUP_ENTRY_C.url));
});

test('grouping: a digest is neither grouped nor marked as read', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_DIGEST]);
    await mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['decision'] }));
    const answer = (regex: string, noul: number) => mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', body: { type: 'REGEX', regex } },
        httpResponse: { statusCode: 200, body: JSON.stringify(decisionAnswer(noul)) },
    });
    await answer(`(?s).*${GROUP_DIGEST.title}.*digest that covers.*`, 0.9);
    await answer('(?s).*digest that covers.*', 0.1);
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_A.url));
    assert.doesNotMatch(put.body.xml ?? put.body.string, new RegExp(GROUP_DIGEST.url));

    const reads = await recorded('PUT', '/v1/entries');
    const readIds = reads.flatMap((r) => entryUpdate(r).entry_ids);
    assert.deepEqual(readIds, [GROUP_ENTRY_A.id]);
});

test('grouping: group title and description are generated by the summary model', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const [item] = items(put.body);
    assert.match(item, /<title>Generated title<\/title>/);
    assert.match(item, /Generated description/);

    const [generate] = await recorded('POST', '/api/generate');
    assert.equal(generate.body.json.model, 'summary-model');
    assert.match(generate.body.json.prompt, new RegExp(GROUP_ENTRY_A.title));
    assert.match(generate.body.json.prompt, new RegExp(GROUP_ENTRY_B.title));
});

test('grouping: summaries are generated only after all grouping decisions', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const all: RecordedRequest[] = (await mock.retrieveRecordedRequests({})) ?? [];
    const paths = all.map((r) => r.path);
    assert.ok(paths.includes('/api/generate'));
    assert.ok(paths.lastIndexOf('/v1/systemone') < paths.indexOf('/api/generate'));
});

test('sequential mode: filtering starts only after grouping and summary generation', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B], [CATEGORY, GROUP_CATEGORY]);
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
    await mockDecision(0.9);

    child = spawnApp({ ...DECISION_ENV, RUN_SEQUENTIALLY: 'true' });
    await runFinished();
    const all: RecordedRequest[] = (await mock.retrieveRecordedRequests({})) ?? [];
    const paths = all.map((r) => r.path);
    const filterDecision = all.findIndex((r) => r.path === '/v1/systemone' && JSON.stringify(r.body).includes(PROMPT.content));
    assert.ok(filterDecision > -1);
    assert.ok(filterDecision > paths.indexOf('/api/generate'));
});

test('grouping: an entry whose classification fails does not block the others', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', body: { type: 'REGEX', regex: `(?s).*${GROUP_ENTRY_A.title}.*` } },
        httpResponse: { statusCode: 500, body: 'boom' },
    });
    await mockDecision(0.9);

    child = spawnApp(DECISION_ENV);
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    const published = items(put.body);
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_B.url));
    assert.doesNotMatch(published[0], new RegExp(GROUP_ENTRY_A.url));

    const reads = await recorded('PUT', '/v1/entries');
    const readIds = reads.flatMap((r) => entryUpdate(r).entry_ids);
    assert.deepEqual(readIds, [GROUP_ENTRY_B.id]);
});

test('grouping: unset batch size means no limit', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp({ ...DECISION_ENV, PROCESSING_BATCH_SIZE: '' });
    await runFinished();
    const [put] = await recorded('PUT', FEED_PATH);
    assert.equal(items(put.body).length, 1);
});

test('grouping: entries are left unread when the b2 settings are incomplete', async () => {
    await mockGroupingSetup([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await mockDecision(0.9);

    child = spawnApp({ ...DECISION_ENV, B2_BUCKET: '' });
    await runFinished();
    const reads = await recorded('PUT', '/v1/entries');
    const readIds = reads.flatMap((r) => entryUpdate(r).entry_ids);
    assert.deepEqual(readIds, []);
});

test('grouping: a grouped entry whose mark-as-read failed is marked on the next run without being classified again', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [GROUP_CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${GROUP_CATEGORY.id}/feeds`, 200, [GROUP_FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${GROUP_FEED.id}/entries`, 200, { entries: [GROUP_ENTRY_A] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 500 } });
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: FEED_PATH }, httpResponse: { statusCode: 200 } });
    await mock.mockAnyResponse(json('GET', '/v1/feeds', 200, []));
    await mockDecision(0.9);
    child = spawnApp(DECISION_ENV);
    await runFinished();
    const exited = once(child, 'exit');
    child.kill();
    await exited;

    await mock.reset();
    await mockGroupingSetup([GROUP_ENTRY_A]);
    await mockDecision(0.9);
    child = spawnApp(DECISION_ENV);
    await runFinished();
    const reads = await recorded('PUT', '/v1/entries');
    const readIds = reads.flatMap((r) => entryUpdate(r).entry_ids);
    assert.deepEqual(readIds, [GROUP_ENTRY_A.id]);
    const classifications = await recorded('POST', '/v1/systemone');
    assert.equal(classifications.length, 0);
});

test('review ui: discarding keeps the newest decisions and drops the rest from prompt history', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY, ENTRY_2] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();
    const pending = await (await fetch(WEB)).text();
    assert.match(pending, /type="number" name="keep" min="0" max="2" value="2"/);

    const discard = await fetch(`${WEB}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['keep', '1']]),
    });
    const afterDiscard = await discard.text();
    assert.match(afterDiscard, new RegExp(ENTRY_2.title));
    assert.doesNotMatch(afterDiscard, new RegExp(ENTRY.title));

    const review = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([[`verdict-${ENTRY_2.id}`, 'wrong']]),
    });
    const prompt = await review.text();
    assert.match(prompt, new RegExp(ENTRY_2.title));
    assert.doesNotMatch(prompt, new RegExp(ENTRY.title));
});

test('review ui: a changed decision brings the entry back for review without its verdict', async () => {
    const mockFilter = async (answer: string) => {
        await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
        await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
        await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY] }));
        await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
        await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: answer, done: true }));
    };
    const post = (path: string, params: string[][]) =>
        fetch(`${WEB}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });

    await mockFilter('yes');
    child = spawnApp();
    await runFinished();
    assert.match(await (await fetch(`${WEB}/pending`)).text(), new RegExp(ENTRY.title));

    await post('/review', [[`verdict-${ENTRY.id}`, 'wrong']]);
    await post('/reviewed', [['reviewed', String(ENTRY.id)]]);
    const exited = once(child, 'exit');
    child.kill();
    await exited;

    await mock.reset();
    await mockFilter('no');
    child = spawnApp();
    await runFinished();
    const pending = await (await fetch(`${WEB}/pending`)).text();
    assert.match(pending, new RegExp(ENTRY.title));
    assert.match(pending, /class="badge no"/);
    assert.doesNotMatch(pending, /checked/);
});

test('review ui: discarding with an invalid keep value is rejected', async () => {
    child = spawnApp();
    await runFinished('failed');
    const res = await fetch(`${WEB}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['keep', 'abc']]),
    });
    assert.equal(res.status, 400);
});

test('review ui: submitting a review with no decision marked is rejected', async () => {
    child = spawnApp();
    await runFinished('failed');
    const res = await fetch(`${WEB}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(),
    });
    assert.equal(res.status, 400);
});

test('review ui: discarding keeps verdicts picked but not yet submitted', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY, ENTRY_2] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();
    const discard = await fetch(`${WEB}/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([['keep', '2'], [`verdict-${ENTRY_2.id}`, 'wrong']]),
    });
    assert.match(await discard.text(), new RegExp(`name="verdict-${ENTRY_2.id}" value="wrong" checked`));
});

test('review ui: decisions with a verdict do not count toward the kept newest ones', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY, ENTRY_2] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp();
    await runFinished();
    const post = (path: string, params: string[][]) =>
        fetch(`${WEB}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(params),
        });

    await post('/review', [[`verdict-${ENTRY_2.id}`, 'wrong']]);
    assert.match(await (await fetch(`${WEB}/pending`)).text(), /name="keep" min="0" max="1"/);

    const afterDiscard = await (await post('/discard', [['keep', '1']])).text();
    assert.match(afterDiscard, new RegExp(ENTRY.title));
    assert.match(afterDiscard, new RegExp(ENTRY_2.title));
});

test('review ui: processing started from the ui runs in the background and reports completion', async () => {
    await mock.mockAnyResponse(json('GET', '/v1/categories', 200, [CATEGORY]));
    await mock.mockAnyResponse(json('GET', `/v1/categories/${CATEGORY.id}/feeds`, 200, [FEED]));
    await mock.mockAnyResponse(json('GET', `/v1/feeds/${FEED.id}/entries`, 200, { entries: [ENTRY, ENTRY_2] }));
    await mock.mockAnyResponse({ httpRequest: { method: 'PUT', path: '/v1/entries' }, httpResponse: { statusCode: 204 } });
    await mock.mockAnyResponse(json('POST', '/api/generate', 200, { response: 'no', done: true }));

    child = spawnApp({ PROCESSING_BATCH_SIZE: '1' });
    await runFinished();

    const started = await (await fetch(`${WEB}/process`, { method: 'POST' })).text();
    assert.match(started, /processing\.\.\./);
    await runFinished();
    assert.match(await (await fetch(`${WEB}/process`)).text(), /process now/);
    const updates = await recorded('PUT', '/v1/entries');
    assert.deepEqual(updates.map((r) => entryUpdate(r).entry_ids), [[ENTRY.id], [ENTRY_2.id]]);
});
