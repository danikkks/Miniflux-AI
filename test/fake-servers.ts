import assert from 'node:assert/strict';
import { createClient, entryUpdate, json, type RecordedRequest } from './mockserver.js';

type Category = { id: number; title: string };
type Feed = { id: number; category: Category };
type Entry = { id: number; title: string; url: string; content: string; feed: Feed };
type Answer = 'yes' | 'likely' | 'no' | 'unsure';

export const FAKE_PORT = 18080;
export const FAKE_URL = `http://localhost:${FAKE_PORT}`;

const mock = createClient(FAKE_PORT);

const OVERRIDE = 1;

const unique = <T extends { id: number }>(items: T[]): T[] =>
    [...new Map(items.map((i) => [i.id, i])).values()];

const status = (method: string, path: string, statusCode: number, priority = 0) =>
    mock.mockAnyResponse({ httpRequest: { method, path }, httpResponse: { statusCode }, priority });

const bodyMatching = (pattern: string) => ({ type: 'REGEX', regex: `(?s).*${pattern}.*` });

export const recorded = async (method?: string, path?: string): Promise<RecordedRequest[]> =>
    (await mock.retrieveRecordedRequests({ method, path })) ?? [];

export const resetFakes = () => mock.reset();

const once = (method: string, path: string, action: { httpError: object } | { httpResponse: object }) => mock.mockAnyResponse({
    httpRequest: { method, path },
    ...action,
    priority: OVERRIDE + 1,
    times: { remainingTimes: 1, unlimited: false },
});

const DROP = { httpError: { dropConnection: true } };

export const miniflux = {
    hasCategories: (categories: Category[]) => mock.mockAnyResponse(json('GET', '/v1/categories', 200, categories)),

    hasUnread: async (entries: Entry[]) => {
        const feeds = unique(entries.map((e) => e.feed));
        const categories = unique(feeds.map((f) => f.category));
        await miniflux.hasCategories(categories);
        for (const category of categories) {
            await mock.mockAnyResponse(json('GET', `/v1/categories/${category.id}/feeds`, 200, feeds.filter((f) => f.category.id === category.id)));
        }
        for (const feed of feeds) {
            await mock.mockAnyResponse(json('GET', `/v1/feeds/${feed.id}/entries`, 200, { entries: entries.filter((e) => e.feed.id === feed.id) }));
        }
        await status('PUT', '/v1/entries', 204);
    },

    dropsConnectionOnUnread: (feed: Feed) => once('GET', `/v1/feeds/${feed.id}/entries`, DROP),

    dropsConnectionOnMarkAsRead: () => once('PUT', '/v1/entries', DROP),

    isUnavailableOnceOnMarkAsRead: () => once('PUT', '/v1/entries', { httpResponse: { statusCode: 503 } }),

    failsToMarkAsRead: () => status('PUT', '/v1/entries', 500, OVERRIDE),

    listsUnreadOnlyOnce: async (entries: Entry[]) => {
        for (const feed of unique(entries.map((e) => e.feed))) {
            const path = `/v1/feeds/${feed.id}/entries`;
            await mock.mockAnyResponse({
                ...json('GET', path, 200, { entries: entries.filter((e) => e.feed.id === feed.id) }),
                priority: OVERRIDE + 1,
                times: { remainingTimes: 1, unlimited: false },
            });
            await status('GET', path, 500, OVERRIDE);
        }
    },

    hasSubscriptions: (feeds: { id: number; feed_url: string }[]) => mock.mockAnyResponse(json('GET', '/v1/feeds', 200, feeds)),

    refreshesFeeds: () => status('PUT', '/v1/feeds/.*/refresh', 204),

    markAsReadCalls: async (): Promise<number[][]> => {
        const updates = (await recorded('PUT', '/v1/entries')).map(entryUpdate);
        assert.deepEqual(updates.filter((u) => u.status !== 'read'), [], 'miniflux got an entry update other than "read"');
        return updates.map((u) => u.entry_ids);
    },

    markedAsRead: async (): Promise<number[]> => (await miniflux.markAsReadCalls()).flat(),

    feedsRequested: async (category: Category) => (await recorded('GET', `/v1/categories/${category.id}/feeds`)).length,

    unreadRequested: async (feed: Feed) => (await recorded('GET', `/v1/feeds/${feed.id}/entries`)).length,
};

const decision = (answer: Answer) => ({
    model: 'nimble:latest',
    answers: { relevant: { type: 'noul', noul: { yes: 0.9, likely: 0.6, no: 0.1, unsure: 0.4 }[answer] } },
    usage: { input_tokens: 1, output_tokens: 1 },
});

export const ollama = {
    summarizes: () => mock.mockAnyResponse(json('POST', '/api/generate', 200, {
        response: JSON.stringify({ title: 'Generated title', description: 'Generated description' }),
        done: true,
    })),

    supportsDecisions: () => mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['decision'] })),

    lacksDecisions: () => mock.mockAnyResponse(json('POST', '/api/show', 200, { capabilities: ['completion'] })),

    decides: (answer: Answer, about?: string) => mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', ...(about && { body: bodyMatching(about) }) },
        httpResponse: { statusCode: 200, body: JSON.stringify(decision(answer)) },
    }),

    failsToDecide: (about: string) => mock.mockAnyResponse({
        httpRequest: { method: 'POST', path: '/v1/systemone', body: bodyMatching(about) },
        httpResponse: { statusCode: 500, body: 'boom' },
        priority: OVERRIDE,
    }),

    dropsConnectionOnDecide: () => once('POST', '/v1/systemone', DROP),

    dropsConnectionOnSummarize: () => once('POST', '/api/generate', DROP),

    decisionRequests: () => recorded('POST', '/v1/systemone'),

    generateRequests: () => recorded('POST', '/api/generate'),
};

export const PUBLISHED_FEED_PATH = '/test-bucket/grouped.xml';

const items = (upload: RecordedRequest): string[] =>
    (upload.body.xml ?? upload.body.string).match(/<item>[\s\S]*?<\/item>/g) ?? [];

export const b2 = {
    acceptsUploads: () => status('PUT', PUBLISHED_FEED_PATH, 200),

    dropsConnectionOnUpload: () => once('PUT', PUBLISHED_FEED_PATH, DROP),

    uploads: () => recorded('PUT', PUBLISHED_FEED_PATH),

    publishedItems: async (): Promise<string[]> => {
        const [upload] = await b2.uploads();
        return items(upload);
    },

    publishedGuids: async (): Promise<string[]> =>
        (await b2.publishedItems()).map((i) => i.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] ?? ''),
};
