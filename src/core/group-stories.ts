import { parentCategory } from "./entities.js";
import type {
    IAIClassifier,
    IEntryUpdater,
    IFeedPublisher,
    IFeedReader,
    IFeedRefresher,
    IGroup,
    IGroupStore,
    IGroupSummarizer,
} from "./entities.js";

const sameStoryPrompt = (group: IGroup): string =>
    `Is the article below about the same news story or event as "${group.summary?.title ?? group.entries[0].title}"? Answer yes or no.`;

const DIGEST_PROMPT =
    "Is the article below a digest that covers several separate news stories? Answer yes or no.";

export type StoryGrouperDeps = {
    feedReader: IFeedReader;
    classifier: IAIClassifier;
    entryUpdater: IEntryUpdater;
    groups: IGroupStore;
    summarizer: IGroupSummarizer;
    publisher: IFeedPublisher;
    feedRefresher: IFeedRefresher;
    categoryTitles: string[];
    windowHours: number;
    batchSize: number;
};

export const makeStoryGrouper = ({
    feedReader,
    classifier,
    entryUpdater,
    groups,
    summarizer,
    publisher,
    feedRefresher,
    categoryTitles,
    windowHours,
    batchSize,
}: StoryGrouperDeps): (() => Promise<void>) => {
    const digestIds: string[] = [];

    return async () => {
        const wanted = categoryTitles.map((t) => t.toLowerCase());
        const categories = (await feedReader.getCategories()).filter((c) =>
            wanted.includes(parentCategory(c.title).toLowerCase()),
        );
        console.debug("groupingCategories", categories.map((c) => c.title));
        const feeds = (
            await Promise.all(categories.map((c) => feedReader.getFeedsByCategory(c.id)))
        ).flat();
        console.debug("groupingFeeds", feeds.map((f) => f.id));
        const unread = (
            await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
        ).flat();
        console.debug("groupingUnreadEntries", unread.map((e) => e.title));

        const alreadyGrouped = new Set(await groups.groupedEntryIds(unread.map((e) => e.id)));
        const stale = unread.filter((e) => alreadyGrouped.has(e.id));
        if (stale.length > 0) {
            try {
                await entryUpdater.markAsRead(stale.map((e) => e.id));
            } catch (err) {
                console.error(err);
            }
        }
        const toGroup = unread.filter((e) => !alreadyGrouped.has(e.id) && !digestIds.includes(e.id))
            .slice(0, batchSize);
        console.debug("groupingEntriesToGroup", toGroup.map((e) => e.title));

        const open = await groups.listGroupsSince(windowHours);
        console.debug("groupingOpenGroups", open.map((g) => ({ id: g.id, title: g.summary?.title ?? g.entries[0].title, entries: g.entries.length })));
        for (const entry of toGroup) {
            try {
                if (await classifier.classify(entry, DIGEST_PROMPT)) {
                    digestIds.push(entry.id);
                    console.debug("groupingDigestSkipped", entry.title);
                    continue;
                }
                let match: IGroup | undefined;
                for (const group of open) {
                    if (await classifier.classify(entry, sameStoryPrompt(group))) {
                        match = group;
                        break;
                    }
                }
                const id = await groups.addToGroup(match?.id ?? null, entry);
                console.debug("groupingEntryGrouped", { entry: entry.title, group: id, new: !match });
                const member = { entryId: entry.id, title: entry.title, url: entry.url, content: entry.content };
                if (match) match.entries.push(member);
                else open.unshift({ id, entries: [member], updatedAt: new Date(), summary: null, summarizedCount: 0 });
                await entryUpdater.markAsRead([entry.id]);
            } catch (err) {
                console.error(err);
            }
        }

        for (const group of await groups.listGroupsSince(windowHours)) {
            if (group.summarizedCount === group.entries.length) continue;
            try {
                const summary = await summarizer.summarize(group);
                await groups.saveSummary(group.id, summary, group.entries.length);
                console.debug("groupingSummary", { group: group.id, ...summary });
            } catch (err) {
                console.error(err);
            }
        }

        const published = await groups.listGroupsSince(windowHours);
        console.debug("groupingPublishing", published.length);
        if (!(await publisher.publish(published))) return;
        const subscriptions = (await feedRefresher.listSubscribedFeeds()).filter((f) => publisher.isPublishedAt(f.url));
        console.debug("groupingRefreshingFeeds", subscriptions);
        await Promise.all(subscriptions.map((f) => feedRefresher.refreshFeed(f.id)));
    };
};
