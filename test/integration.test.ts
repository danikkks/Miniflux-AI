import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { writeFile, unlink, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PROMPT, FEED, ENTRY, ENTRY_2, ENTRY_3, GROUP_ENTRY_A, GROUP_ENTRY_B, GROUP_ENTRY_C, GROUP_DIGEST, GROUP_JOB_AD, GROUP_FEED } from './fixtures.js';
import { startServer } from './mockserver.js';
import { FAKE_PORT, FAKE_URL, PUBLISHED_FEED_PATH, b2, miniflux, ollama, recorded, resetFakes } from './fake-servers.js';
import { makeApplicationRunner } from './application-runner.js';

const ROOT = resolve(import.meta.dirname, '..');
const PROMPT_FILE = resolve(ROOT, PROMPT.filename);

const DB_FILE = resolve(ROOT, 'test-miniflux-ai.db');
const LOG_DIR = resolve(ROOT, 'test-logs');

const WEB_PORT = 18081;
const WEB = `http://localhost:${WEB_PORT}`;

const app = makeApplicationRunner(ROOT, WEB, {
    MINIFLUX_URL: FAKE_URL,
    MINIFLUX_AUTH_TOKEN: 'test',
    OLLAMA_BASE_URL: FAKE_URL,
    OLLAMA_MODEL: 'nimble:latest',
    DATABASE_PATH: DB_FILE,
    LOG_DIR,
    WEB_PORT: String(WEB_PORT),
    GROUPING_CATEGORIES: 'world news',
    B2_ENDPOINT: FAKE_URL,
    B2_REGION: 'us-west-004',
    B2_BUCKET: 'test-bucket',
    B2_KEY_ID: 'key-id',
    B2_APPLICATION_KEY: 'app-key',
});

const GROUPING_ENV = { OLLAMA_SUMMARY_MODEL: 'summary-model' };

let fakeServer: ChildProcess | undefined;

const postForm = (path: string, params: string[][]) =>
    fetch(`${WEB}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
    });

const page = async (path = '') => (await fetch(`${WEB}${path}`)).text();

const givenGrouping = async (entries: Parameters<typeof miniflux.hasUnread>[0], subscriptions: { id: number; feed_url: string }[] = []) => {
    await miniflux.hasUnread(entries);
    await miniflux.hasSubscriptions(subscriptions);
    await b2.acceptsUploads();
};

const givenDecision = async (answer: 'yes' | 'likely' | 'no' | 'unsure') => {
    await ollama.supportsDecisions();
    await ollama.decides(answer);
};

const givenDecisions = async (answer: 'yes' | 'likely' | 'no') => {
    await ollama.summarizes();
    await ollama.decides('no', 'several separate news stories');
    await ollama.decides('yes', 'specific news event');
    await givenDecision(answer);
};

before(async () => {
    await writeFile(PROMPT_FILE, PROMPT.content);
    fakeServer = await startServer(FAKE_PORT);
});

beforeEach(async () => {
    await app.stop();
    await unlink(DB_FILE).catch(() => {});
    await resetFakes();
});

after(async () => {
    await app.stop();
    await unlink(PROMPT_FILE).catch(() => {});
    await unlink(DB_FILE).catch(() => {});
    await rm(LOG_DIR, { recursive: true, force: true });
    fakeServer?.kill();
});

test('nothing is processed until triggered from the ui', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');

    await app.start();

    assert.doesNotMatch(await page('/process'), /processing/);
});

test('app exits with an error when the review ui port is taken', async () => {
    const blocker = createServer().listen(WEB_PORT);
    await once(blocker, 'listening');
    try {
        app.launch();

        assert.equal(await app.exitCode(), 1);
    } finally {
        blocker.close();
    }
});

test('entry classified as "no" is marked as read', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), [ENTRY.id]);
});

test('filtering: miniflux calls are retried after a dropped connection', async () => {
    await miniflux.hasUnread([ENTRY]);
    await miniflux.dropsConnectionOnUnread(FEED);
    await miniflux.dropsConnectionOnMarkAsRead();
    await givenDecision('no');

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), [ENTRY.id, ENTRY.id]);
});

test('filtering: miniflux calls are retried after a 503 response', async () => {
    await miniflux.hasUnread([ENTRY]);
    await miniflux.isUnavailableOnceOnMarkAsRead();
    await givenDecision('no');

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), [ENTRY.id, ENTRY.id]);
});

const reviewRow = (decision: 'yes' | 'no', entry: typeof ENTRY) =>
    new RegExp(`class="badge ${decision}">${decision}</span>\\s*<a href="${entry.url}"[^>]*>${entry.title}</a>\\s*<small>${entry.feed.category.title}</small>`);

test('entry classified as "no" is listed for review with its decision', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');

    await app.runOnce();

    assert.match(await page('/pending'), reviewRow('no', ENTRY));
});

test('entry classified as "yes" is listed for review with its decision', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('yes');

    await app.runOnce();

    assert.match(await page('/pending'), reviewRow('yes', ENTRY));
});

test('entry with an unsure classification is not marked as read', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('unsure');

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), []);
});

test('entry classified as "yes" is not marked as read', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('yes');

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), []);
});

test('filtering: one run classifies all entries one by one', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await givenDecision('no');

    await app.runOnce();

    assert.deepEqual(await miniflux.markAsReadCalls(), [[ENTRY.id], [ENTRY_2.id]]);
    assert.equal(await miniflux.unreadRequested(FEED), 2);
});

test('filtering: a failing entry is attempted once per run', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await ollama.failsToDecide(ENTRY.title);
    await givenDecision('no');

    await app.runOnce();

    const attempts = (await ollama.decisionRequests()).filter((r) => JSON.stringify(r.body).includes(ENTRY.title));
    assert.equal(attempts.length, 1);
    assert.deepEqual(await miniflux.markedAsRead(), [ENTRY_2.id]);
});

test('model missing "decision" capability is never marked as read', async () => {
    await miniflux.hasUnread([ENTRY]);
    await ollama.lacksDecisions();

    await app.runOnce();

    assert.deepEqual(await miniflux.markedAsRead(), []);
});

test('short entry is classified with its body, not only its title', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');

    await app.runOnce();

    const [req] = await ollama.decisionRequests();
    assert.match(req.body.json.state, new RegExp(ENTRY.content));
});

test('category without matching prompt - no feeds fetched', async () => {
    const sportsCategory = { id: 2, title: 'Sports News' };
    await miniflux.hasCategories([sportsCategory]);

    await app.runOnce();

    assert.equal(await miniflux.feedsRequested(sportsCategory), 0);
});

test('review ui: marking a decision wrong yields a prompt-tweak text for the category', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');

    await app.runOnce();

    assert.match(await page(), new RegExp(ENTRY.title));

    const prompt = await (await postForm('/review', [[`verdict-${ENTRY.id}`, 'wrong']])).text();
    assert.ok(prompt.includes(PROMPT.content));
    assert.match(prompt, /Wrong decisions \(1\)/);
    assert.match(prompt, /classifier answered: no \| correct answer: yes/);

    const stillPending = await page('/pending');
    assert.match(stillPending, new RegExp(ENTRY.title));
    assert.match(stillPending, /name="verdict-100" value="wrong" checked/);

    await postForm('/reviewed', [['reviewed', String(ENTRY.id)]]);
    assert.doesNotMatch(await page('/pending'), new RegExp(ENTRY.title));
});

test('review ui: decision not marked wrong is reported as correct', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('yes');

    await app.runOnce();

    const prompt = await (await postForm('/review', [[`verdict-${ENTRY.id}`, 'correct']])).text();
    assert.match(prompt, /Wrong decisions \(0\)/);
    assert.match(prompt, /Correct decisions \(1\)/);
});

test('review ui: prompt includes decisions reviewed in earlier rounds', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await givenDecision('no');

    await app.runOnce();

    await postForm('/review', [[`verdict-${ENTRY.id}`, 'wrong']]);
    await postForm('/reviewed', [['reviewed', String(ENTRY.id)]]);
    const second = await (await postForm('/review', [[`verdict-${ENTRY_2.id}`, 'correct']])).text();
    assert.ok(second.includes(ENTRY.title));
    assert.ok(second.includes(ENTRY_2.title));
    assert.match(second, /Wrong decisions \(1\)/);
    assert.match(second, /Correct decisions \(1\)/);
});

test('oversized entry is truncated to fit the 64 KiB request limit', async () => {
    await miniflux.hasUnread([{ ...ENTRY, content: 'x'.repeat(200_000) }]);
    await ollama.supportsDecisions();
    await ollama.decides('no');

    await app.runOnce();

    const [req] = await ollama.decisionRequests();
    const size = Number(req.headers['content-length'][0]);
    assert.ok(size <= 64 * 1024, `request body was ${size} bytes`);
});

test('review ui: subcategories share one prompt with their parent category', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_3]);
    await givenDecision('no');

    await app.runOnce();

    const html = await (await postForm('/review', [
        [`verdict-${ENTRY.id}`, 'correct'],
        [`verdict-${ENTRY_3.id}`, 'wrong'],
    ])).text();
    assert.equal(html.match(/<textarea/g)?.length, 1);
    assert.ok(html.includes(ENTRY.title));
    assert.ok(html.includes(ENTRY_3.title));
    assert.match(html, /<h3>Technology News<\/h3>/);
});

test('grouping: articles about the same story are published as one feed item', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.match(item, new RegExp(GROUP_ENTRY_B.url));
    const [upload] = await b2.uploads();
    assert.match(upload.headers['content-type'][0], /rss\+xml/);
});

test('grouping: a dropped connection to ollama or b2 does not fail the run', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');
    await ollama.dropsConnectionOnDecide();
    await ollama.dropsConnectionOnSummarize();
    await b2.dropsConnectionOnUpload();

    await app.runOnce(GROUPING_ENV);

    const last = (await b2.uploads()).at(-1);
    const upload = last?.body.xml ?? last?.body.string ?? '';
    assert.match(upload, new RegExp(GROUP_ENTRY_A.url));
    assert.match(upload, new RegExp(GROUP_ENTRY_B.url));
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
});

test('grouping: miniflux refreshes only the feed subscribed to the published file', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B], [
        { id: 98, feed_url: 'http://example.com/grouped.xml' },
        { id: 99, feed_url: `${FAKE_URL}${PUBLISHED_FEED_PATH}` },
    ]);
    await givenDecisions('yes');
    await miniflux.refreshesFeeds();

    await app.runOnce(GROUPING_ENV);

    const paths = (await recorded()).map((r) => r.path);
    assert.ok(paths.indexOf(PUBLISHED_FEED_PATH) < paths.indexOf('/v1/feeds/99/refresh'));
    assert.ok(!paths.includes('/v1/feeds/98/refresh'));
});

test('grouping: articles about different stories are published as separate feed items', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('no');

    await app.runOnce(GROUPING_ENV);

    const guids = await b2.publishedGuids();
    assert.equal(guids.length, 2);
    assert.equal(new Set(guids).size, 2);
});

test('grouping: a group that gets a new article is published under a new guid', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);
    await app.stop();
    const [before] = await b2.publishedGuids();

    await resetFakes();
    await givenGrouping([GROUP_ENTRY_B]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.match(item, new RegExp(GROUP_ENTRY_B.url));
    assert.notEqual((await b2.publishedGuids())[0], before);
});

test('grouping: groups made after the database is wiped do not reuse guids', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);
    await app.stop();
    const [before] = await b2.publishedGuids();

    await unlink(DB_FILE);
    await resetFakes();
    await givenGrouping([GROUP_ENTRY_B]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);

    assert.notEqual((await b2.publishedGuids())[0], before);
});

test('grouping: the article that started a group stays first when an older article joins it', async () => {
    await givenGrouping([GROUP_ENTRY_B, GROUP_ENTRY_A]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item] = await b2.publishedItems();
    assert.match(item, new RegExp(`<link>${GROUP_ENTRY_B.url}</link>`));
});

test('grouping: grouped articles are marked as read in miniflux', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    assert.deepEqual((await miniflux.markedAsRead()).sort(), [GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
});

test('grouping: article is added to a group stored by a previous run', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);
    await app.stop();

    await resetFakes();
    await givenGrouping([GROUP_ENTRY_B]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.match(item, new RegExp(GROUP_ENTRY_B.url));
});

test('grouping: the same-story question carries the group\'s first article as a reference in the state', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [sameStory] = (await ollama.decisionRequests())
        .filter((r) => JSON.stringify(r.body).includes('the reference story?'))
        .map((r) => r.body.json);
    assert.match(sameStory.state, new RegExp(`Reference story:\\n${GROUP_ENTRY_A.title}\\n${GROUP_ENTRY_A.content}`));
    assert.match(sameStory.state, new RegExp(`Article:\\n${GROUP_ENTRY_B.title}`));
});

test('grouping: a likely but not confident match starts a new group', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('likely');

    await app.runOnce(GROUPING_ENV);

    assert.equal((await b2.publishedItems()).length, 2);
});

test('grouping: the generated group title does not replace the first article in the reference story', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);
    await app.stop();

    await resetFakes();
    await givenGrouping([GROUP_ENTRY_B]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);

    const [sameStory] = (await ollama.decisionRequests())
        .filter((r) => JSON.stringify(r.body).includes('the reference story?'))
        .map((r) => r.body.json);
    assert.match(sameStory.state, new RegExp(`Reference story:\\n${GROUP_ENTRY_A.title}\\n`));
});

test('grouping and filtering run side by side', async () => {
    await givenGrouping([ENTRY, GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await ollama.decides('yes', 'same news story');
    await givenDecisions('no');

    await app.runOnce(GROUPING_ENV);

    assert.deepEqual((await miniflux.markedAsRead()).sort(), [ENTRY.id, GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
    assert.equal((await b2.publishedItems()).length, 1);
});

test('grouping: nothing is published without a summary model', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecision('yes');

    await app.runOnce();

    assert.equal((await b2.uploads()).length, 0);
    assert.equal((await ollama.generateRequests()).length, 0);
});

test('grouping: subcategory articles are grouped together with their parent category', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_C]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.match(item, new RegExp(GROUP_ENTRY_C.url));
});

test('grouping: a digest is neither grouped nor marked as read', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_DIGEST]);
    await ollama.decides('yes', `${GROUP_DIGEST.title}.*several separate news stories`);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const published = await b2.publishedItems();
    assert.equal(published.length, 1);
    assert.match(published[0], new RegExp(GROUP_ENTRY_A.url));
    assert.doesNotMatch(published.join(), new RegExp(GROUP_DIGEST.url));
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_A.id]);
});

test('grouping: an article that is not a news event is marked as read without being grouped', async () => {
    await givenGrouping([GROUP_JOB_AD, GROUP_ENTRY_A]);
    await ollama.decides('no', `${GROUP_JOB_AD.title}.*specific news event`);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const published = await b2.publishedItems();
    assert.equal(published.length, 1);
    assert.doesNotMatch(published.join(), new RegExp(GROUP_JOB_AD.url));
    assert.deepEqual((await miniflux.markedAsRead()).sort(), [GROUP_ENTRY_A.id, GROUP_JOB_AD.id].sort());
});

test('grouping: group title and description are generated by the summary model', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item] = await b2.publishedItems();
    assert.match(item, /<title>Generated title<\/title>/);
    assert.match(item, /Generated description/);
    const [generate] = await ollama.generateRequests();
    assert.equal(generate.body.json.model, 'summary-model');
    assert.match(generate.body.json.prompt, new RegExp(GROUP_ENTRY_A.title));
    assert.match(generate.body.json.prompt, new RegExp(GROUP_ENTRY_B.title));
});

test('grouping: summaries are generated only after all grouping decisions', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const paths = (await recorded()).map((r) => r.path);
    assert.ok(paths.includes('/api/generate'));
    assert.ok(paths.lastIndexOf('/v1/systemone') < paths.indexOf('/api/generate'));
});

test('sequential mode: filtering starts only after grouping and summary generation', async () => {
    await givenGrouping([ENTRY, GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce({ ...GROUPING_ENV, RUN_SEQUENTIALLY: 'true' });

    const all = await recorded();
    const filterDecision = all.findIndex((r) => r.path === '/v1/systemone' && JSON.stringify(r.body).includes(PROMPT.content));
    assert.ok(filterDecision > -1);
    assert.ok(filterDecision > all.map((r) => r.path).indexOf('/api/generate'));
});

test('grouping: an entry whose classification fails does not block the others', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await ollama.failsToDecide(GROUP_ENTRY_A.title);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_B.url));
    assert.doesNotMatch(item, new RegExp(GROUP_ENTRY_A.url));
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_B.id]);
});

test('grouping: one run groups all entries', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const [item] = await b2.publishedItems();
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.match(item, new RegExp(GROUP_ENTRY_B.url));
    assert.equal((await ollama.generateRequests()).length, 1);
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_A.id, GROUP_ENTRY_B.id]);
    assert.equal(await miniflux.unreadRequested(GROUP_FEED), 2);
});

test('grouping: a failed refetch of unread entries still publishes what was grouped and fails the run', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await miniflux.listsUnreadOnlyOnce([GROUP_ENTRY_A]);
    await givenDecisions('yes');

    await app.start(GROUPING_ENV);
    await app.processNow();
    await app.runFinished('failed');

    const [item, ...others] = await b2.publishedItems();
    assert.equal(others.length, 0);
    assert.match(item, new RegExp(GROUP_ENTRY_A.url));
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_A.id]);
});

test('grouping: a failing entry is attempted once per run', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await ollama.failsToDecide(GROUP_ENTRY_A.title);
    await givenDecisions('yes');

    await app.runOnce(GROUPING_ENV);

    const decisions = await ollama.decisionRequests();
    assert.equal(decisions.filter((r) => JSON.stringify(r.body).includes(GROUP_ENTRY_A.title)).length, 1);
    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_B.id]);
});

test('grouping: entries are left unread when the b2 settings are incomplete', async () => {
    await givenGrouping([GROUP_ENTRY_A, GROUP_ENTRY_B]);
    await givenDecisions('yes');

    await app.runOnce({ ...GROUPING_ENV, B2_BUCKET: '' });

    assert.deepEqual(await miniflux.markedAsRead(), []);
});

test('grouping: a grouped entry whose mark-as-read failed is marked on the next run without being classified again', async () => {
    await givenGrouping([GROUP_ENTRY_A]);
    await miniflux.failsToMarkAsRead();
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);
    await app.stop();

    await resetFakes();
    await givenGrouping([GROUP_ENTRY_A]);
    await givenDecisions('yes');
    await app.runOnce(GROUPING_ENV);

    assert.deepEqual(await miniflux.markedAsRead(), [GROUP_ENTRY_A.id]);
    assert.equal((await ollama.decisionRequests()).length, 0);
});

test('review ui: discarding keeps the newest decisions and drops the rest from prompt history', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await givenDecision('no');

    await app.runOnce();

    assert.match(await page(), /type="number" name="keep" min="0" max="2" value="2"/);

    const afterDiscard = await (await postForm('/discard', [['keep', '1']])).text();
    assert.match(afterDiscard, new RegExp(ENTRY_2.title));
    assert.doesNotMatch(afterDiscard, new RegExp(ENTRY.title));

    const prompt = await (await postForm('/review', [[`verdict-${ENTRY_2.id}`, 'wrong']])).text();
    assert.match(prompt, new RegExp(ENTRY_2.title));
    assert.doesNotMatch(prompt, new RegExp(ENTRY.title));
});

test('review ui: a changed decision brings the entry back for review without its verdict', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('yes');
    await app.runOnce();
    assert.match(await page('/pending'), new RegExp(ENTRY.title));
    await postForm('/review', [[`verdict-${ENTRY.id}`, 'wrong']]);
    await postForm('/reviewed', [['reviewed', String(ENTRY.id)]]);
    await app.stop();

    await resetFakes();
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');
    await app.runOnce();

    const pending = await page('/pending');
    assert.match(pending, new RegExp(ENTRY.title));
    assert.match(pending, /class="badge no"/);
    assert.doesNotMatch(pending, /checked/);
});

test('review ui: discarding with an invalid keep value is rejected', async () => {
    await app.start();

    const res = await postForm('/discard', [['keep', 'abc']]);

    assert.equal(res.status, 400);
});

test('review ui: submitting a review with no decision marked is rejected', async () => {
    await app.start();

    const res = await postForm('/review', []);

    assert.equal(res.status, 400);
});

test('review ui: discarding keeps verdicts picked but not yet submitted', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await givenDecision('no');

    await app.runOnce();

    const discard = await postForm('/discard', [['keep', '2'], [`verdict-${ENTRY_2.id}`, 'wrong']]);
    assert.match(await discard.text(), new RegExp(`name="verdict-${ENTRY_2.id}" value="wrong" checked`));
});

test('review ui: decisions with a verdict do not count toward the kept newest ones', async () => {
    await miniflux.hasUnread([ENTRY, ENTRY_2]);
    await givenDecision('no');

    await app.runOnce();

    await postForm('/review', [[`verdict-${ENTRY_2.id}`, 'wrong']]);
    assert.match(await page('/pending'), /name="keep" min="0" max="1"/);
    const afterDiscard = await (await postForm('/discard', [['keep', '1']])).text();
    assert.match(afterDiscard, new RegExp(ENTRY.title));
    assert.match(afterDiscard, new RegExp(ENTRY_2.title));
});

test('review ui: processing started from the ui runs in the background and reports completion', async () => {
    await miniflux.hasUnread([ENTRY]);
    await givenDecision('no');
    await app.start();

    assert.match(await app.processNow(), /processing\.\.\./);
    await app.runFinished();

    assert.match(await page('/process'), /process now/);
    assert.deepEqual(await miniflux.markedAsRead(), [ENTRY.id]);
});
