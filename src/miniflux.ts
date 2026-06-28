import type {
    ICategory,
    IFeed,
    IEntry,
    IFeedReader,
    IEntryUpdater,
} from "./core.js";

export const makeMinifluxClient = (
    baseUrl: string,
    authToken: string,
): IFeedReader & IEntryUpdater => {
    const headers = () => new Headers({ "X-Auth-Token": authToken });

    return {
        getCategories: async () => {
            const r = await fetch(`${baseUrl}/v1/categories`, { headers: headers() });
            return r.json() as Promise<ICategory[]>;
        },

        getFeedsByCategory: async (categoryId) => {
            const r = await fetch(`${baseUrl}/v1/categories/${categoryId}/feeds`, { headers: headers() });
            return r.json() as Promise<IFeed[]>;
        },

        getUnreadEntries: async (feedId) => {
            const r = await fetch(
                `${baseUrl}/v1/feeds/${feedId}/entries?status=unread&order=published_at&direction=asc&limit=100`,
                { headers: headers() },
            );
            const page = await (r.json() as Promise<{ entries: IEntry[] }>);
            return page.entries;
        },

        markAsRead: async (entryIds) => {
            await fetch(`${baseUrl}/v1/entries`, {
                method: "PUT",
                headers: headers(),
                body: JSON.stringify({ status: "read", entry_ids: entryIds }),
            });
        },
    };
};
