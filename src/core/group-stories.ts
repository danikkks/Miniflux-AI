import { NO_PROBABILITY, parentCategory, YES_PROBABILITY } from "./entities.js";
import type {
    IAIClassifier,
    IReference,
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

const SAME_STORY_PROMPT = "Is the article about the same news story or event as the reference story?";

const SAME_STORY_CRITERIA = {
    true: "it reports the same specific event as the reference story",
    false: "it is about a different event, even if it shares the topic, place or people with the reference story",
};

const SAME_STORY_PROBABILITY = 0.7;

const referenceOf = (group: IGroup): IReference => ({
    title: group.entries[0].title,
    content: group.entries[0].content,
});

const DIGEST_PROMPT = "Is the article below a digest?";

const DIGEST_CRITERIA = {
    true: "it covers several separate news stories, each with its own body text",
    false: "it covers a single story; \"Read also\" and related-links sections are not stories",
};

const NEWS_EVENT_PROMPT = "Does the article report a specific news event?";

const NEWS_EVENT_CRITERIA = {
    true: "it reports something that happened or was said at a specific time, such as an attack, a decision or a statement",
    false: "it is not news about an event, such as a job ad, a promotion, a newsletter sign-up or a page about the publisher",
};

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
        const fetchErrors: unknown[] = [];
        const fetchUnhandledOrStopGrouping = async (): Promise<IEntry[]> => {
            try {
                return await fetchUnhandled();
            } catch (err) {
                fetchErrors.push(err);
                log.error("fetching unread entries failed, grouping stopped", err);
                return [];
            }
        };
        let grouped = 0;
        let failed = 0;
        for (let pending = await fetchUnhandledOrStopGrouping(); pending.length > 0; pending = await fetchUnhandledOrStopGrouping()) {
            log.info("%d to group", pending.length);
            for (const [i, entry] of pending.entries()) {
                handled.add(entry.id);
                const progress = `[${i + 1}/${pending.length}] entry ${entry.id} "${entry.title}"`;
                log.debug("grouping entry %s", entry.id, entry);
                try {
                    if (await classifier.classify(entry, DIGEST_PROMPT, DIGEST_CRITERIA) >= YES_PROBABILITY) {
                        digestIds.push(entry.id);
                        log.info("%s -> digest, skipped", progress);
                        continue;
                    }
                    if (await classifier.classify(entry, NEWS_EVENT_PROMPT, NEWS_EVENT_CRITERIA) < NO_PROBABILITY) {
                        await entryUpdater.markAsRead([entry.id]);
                        log.info("%s -> not a news event, marked as read", progress);
                        continue;
                    }
                    let match: IGroup | undefined;
                    for (const group of open) {
                        if (await classifier.classify(entry, SAME_STORY_PROMPT, SAME_STORY_CRITERIA, referenceOf(group)) >= SAME_STORY_PROBABILITY) {
                            match = group;
                            break;
                        }
                    }
                    const id = await groups.addToGroup(match?.id ?? null, entry);
                    log.info("%s -> %s", progress, match ? `group ${id} "${match.entries[0].title}"` : `new group ${id}`);
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
        if (fetchErrors.length > 0) throw new AggregateError(fetchErrors, "grouping stopped early: fetching unread entries failed");
    };
};
