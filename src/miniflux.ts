import type {
    ICategory,
    IFeed,
    IEntry,
    IFeedReader,
    IEntryUpdater,
} from "./core.js";

type MinifluxCategory = { id: number; title: string };
type MinifluxFeed = { id: number; category: MinifluxCategory };
type MinifluxEntry = { id: number; title: string; url: string; content: string; feed: MinifluxFeed };

const toCategory = (c: MinifluxCategory): ICategory => ({ id: String(c.id), title: c.title });

const toFeed = (f: MinifluxFeed): IFeed => ({ id: String(f.id), category: toCategory(f.category) });

const toEntry = (e: MinifluxEntry): IEntry => ({
    id: String(e.id),
    title: e.title,
    url: e.url,
    content: e.content,
    feed: toFeed(e.feed),
});

export const makeMinifluxClient = (
    baseUrl: string,
    authToken: string,
): IFeedReader & IEntryUpdater => {
    const headers = () => new Headers({ "X-Auth-Token": authToken });

    return {
        getCategories: async () => {
            const r = await fetch(`${baseUrl}/v1/categories`, { headers: headers() });
            return (await (r.json() as Promise<MinifluxCategory[]>)).map(toCategory);
        },

        getFeedsByCategory: async (categoryId) => {
            const r = await fetch(`${baseUrl}/v1/categories/${categoryId}/feeds`, { headers: headers() });
            return (await (r.json() as Promise<MinifluxFeed[]>)).map(toFeed);
        },

        getUnreadEntries: async (feedId) => {
            const r = await fetch(
                `${baseUrl}/v1/feeds/${feedId}/entries?status=unread&order=published_at&direction=asc&limit=100`,
                { headers: headers() },
            );
            const page = await (r.json() as Promise<{ entries: MinifluxEntry[] }>);
            return page.entries.map(toEntry);
        },

        markAsRead: async (entryIds) => {
            const r = await fetch(`${baseUrl}/v1/entries`, {
                method: "PUT",
                headers: headers(),
                body: JSON.stringify({ status: "read", entry_ids: entryIds.map(Number) }),
            });
            if (!r.ok) throw new Error(`marking entries as read failed: ${r.status}`);
        },
    };
};
