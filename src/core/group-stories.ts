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
    ILogger,
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
    log: ILogger;
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
    log,
}: StoryGrouperDeps): (() => Promise<void>) => {
    const digestIds: string[] = [];

    return async () => {
        const startedAt = Date.now();
        log.info("run started");

        const wanted = categoryTitles.map((t) => t.toLowerCase());
        const categories = (await feedReader.getCategories()).filter((c) =>
            wanted.includes(parentCategory(c.title).toLowerCase()),
        );
        log.debug("categories", categories);
        const feeds = (
            await Promise.all(categories.map((c) => feedReader.getFeedsByCategory(c.id)))
        ).flat();
        log.debug("feeds", feeds);
        const unread = (
            await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
        ).flat();

        const alreadyGrouped = new Set(await groups.groupedEntryIds(unread.map((e) => e.id)));
        const stale = unread.filter((e) => alreadyGrouped.has(e.id));
        if (stale.length > 0) {
            try {
                await entryUpdater.markAsRead(stale.map((e) => e.id));
                log.info("%d already grouped entries marked as read again", stale.length);
            } catch (err) {
                log.error("marking already grouped entries as read failed", err);
            }
        }
        const toGroup = unread.filter((e) => !alreadyGrouped.has(e.id) && !digestIds.includes(e.id))
            .slice(0, batchSize);

        const open = await groups.listGroupsSince(windowHours);
        log.info(
            "%d categories, %d feeds, %d unread entries, %d to group, %d open groups",
            categories.length, feeds.length, unread.length, toGroup.length, open.length,
        );
        let grouped = 0;
        let failed = 0;
        for (const [i, entry] of toGroup.entries()) {
            const progress = `[${i + 1}/${toGroup.length}] entry ${entry.id} "${entry.title}"`;
            log.debug("grouping entry %s", entry.id, entry);
            try {
                if (await classifier.classify(entry, DIGEST_PROMPT)) {
                    digestIds.push(entry.id);
                    log.info("%s -> digest, skipped", progress);
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
                log.info("%s -> %s", progress, match ? `group ${id} "${match.summary?.title ?? match.entries[0].title}"` : `new group ${id}`);
                const member = { entryId: entry.id, title: entry.title, url: entry.url, content: entry.content };
                if (match) match.entries.push(member);
                else open.unshift({ id, entries: [member], updatedAt: new Date(), summary: null, summarizedCount: 0 });
                await entryUpdater.markAsRead([entry.id]);
                grouped++;
            } catch (err) {
                failed++;
                log.error("%s failed, retrying next run", progress, err);
            }
        }

        const changed = (await groups.listGroupsSince(windowHours))
            .filter((g) => g.summarizedCount !== g.entries.length);
        log.info("summarizing %d changed groups", changed.length);
        for (const [i, group] of changed.entries()) {
            try {
                const summary = await summarizer.summarize(group);
                await groups.saveSummary(group.id, summary, group.entries.length);
                log.info("[%d/%d] group %s summarized: \"%s\"", i + 1, changed.length, group.id, summary.title);
                log.debug("group %s summary", group.id, summary);
            } catch (err) {
                log.error("[%d/%d] group %s summary failed", i + 1, changed.length, group.id, err);
            }
        }

        const published = await groups.listGroupsSince(windowHours);
        if (await publisher.publish(published)) {
            log.info("feed published with %d groups", published.length);
            const subscriptions = (await feedRefresher.listSubscribedFeeds()).filter((f) => publisher.isPublishedAt(f.url));
            await Promise.all(subscriptions.map((f) => feedRefresher.refreshFeed(f.id)));
            log.info("%d miniflux feeds refreshed", subscriptions.length);
        } else {
            log.info("feed unchanged, upload skipped");
        }
        log.info(
            "run finished in %ss: %d grouped, %d failed",
            ((Date.now() - startedAt) / 1000).toFixed(1), grouped, failed,
        );
    };
};
