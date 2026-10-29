import { parentCategory } from "./entities.js";
import type {
    IAIClassifier,
    IEntryUpdater,
    IFeedPublisher,
    IFeedReader,
    IFeedRefresher,
    IEntry,
    IGroup,
    IGroupStore,
    IGroupSummarizer,
    ILogger,
} from "./entities.js";

const sameStoryPrompt = (group: IGroup): string =>
    `Is the article below about the same news story or event as "${group.summary?.title ?? group.entries[0].title}"? Answer yes or no.`;

const DIGEST_PROMPT =
    "Is the article below a digest that covers several separate news stories, each with its own body text? " +
    "\"Read also\" and related-links sections are not stories. Answer yes or no.";

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
        const open = await groups.listGroupsSince(windowHours);
        log.info("%d categories, %d feeds, %d open groups", categories.length, feeds.length, open.length);
        const handled = new Set<string>();
        const fetchUnhandled = async (): Promise<IEntry[]> => {
            // TODO: unread but skipped entries (digests, failures) fill the miniflux 100 per feed window and can hide newer entries
            const unread = (
                await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
            ).flat().filter((e) => !handled.has(e.id) && !digestIds.includes(e.id));
            const alreadyGrouped = new Set(await groups.groupedEntryIds(unread.map((e) => e.id)));
            const stale = unread.filter((e) => alreadyGrouped.has(e.id));
            stale.forEach((e) => handled.add(e.id));
            if (stale.length > 0) {
                try {
                    await entryUpdater.markAsRead(stale.map((e) => e.id));
                    log.info("%d already grouped entries marked as read again", stale.length);
                } catch (err) {
                    log.error("marking already grouped entries as read failed", err);
                }
            }
            return unread.filter((e) => !alreadyGrouped.has(e.id));
        };
        let grouped = 0;
        let failed = 0;
        let pending = await fetchUnhandled();
        for (let batch = 1; pending.length > 0; batch++) {
            const toGroup = pending.slice(0, batchSize);
            pending = pending.slice(toGroup.length);
            log.info("batch %d: %d to group, %d pending", batch, toGroup.length, pending.length);
            for (const [i, entry] of toGroup.entries()) {
                handled.add(entry.id);
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
            if (pending.length === 0) pending = await fetchUnhandled();
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
