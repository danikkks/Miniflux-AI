import { stripHtml } from "string-strip-html";

export type ICategory = {
    id: string;
    title: string;
};

export type IFeed = {
    id: string;
    category: ICategory;
};

export type IEntry = {
    id: string;
    title: string;
    url: string;
    content: string;
    feed: IFeed;
};

export type Decision = "yes" | "no";

export type IDecision = {
    entry: IEntry;
    decision: Decision;
};

export type Verdict = "correct" | "wrong";

export type IStoredDecision = {
    entryId: string;
    title: string;
    url: string;
    content: string;
    category: string;
    decision: Decision;
    verdict: Verdict | null;
};

export type IVerdict = {
    entryId: string;
    verdict: Verdict;
};

export type IReviewItem = Omit<IStoredDecision, "content"> & {
    excerpt: string;
};

export type IReviewPrompt = {
    category: string;
    text: string;
    entryIds: string[];
};

export type IGroupedEntry = {
    entryId: string;
    title: string;
    url: string;
    content: string;
};

export type IGroupSummary = {
    title: string;
    description: string;
};

export type IGroup = {
    id: string;
    entries: IGroupedEntry[];
    updatedAt: Date;
    summary: IGroupSummary | null;
    summarizedCount: number;
};

export type ICustomPrompt = {
    category: string;
    content: string;
};

export interface IFeedReader {
    getCategories(): Promise<ICategory[]>;
    getFeedsByCategory(categoryId: string): Promise<IFeed[]>;
    getUnreadEntries(feedId: string): Promise<IEntry[]>;
}

export interface IAIClassifier {
    classify(entry: IEntry, prompt: string): Promise<boolean>;
}

export interface IEntryUpdater {
    markAsRead(entryIds: string[]): Promise<void>;
}

export interface IDatabase {
    saveDecisions(decisions: IDecision[]): Promise<void>;
    listUnreviewedDecisions(): Promise<IStoredDecision[]>;
    getDecisions(entryIds: string[]): Promise<IStoredDecision[]>;
    listVerdictCategories(): Promise<string[]>;
    listRecentVerdicts(categories: string[], limit: number): Promise<IStoredDecision[]>;
    saveVerdicts(verdicts: IVerdict[]): Promise<void>;
    resetVerdicts(entryIds: string[]): Promise<void>;
    markReviewed(entryIds: string[]): Promise<void>;
    discardUnreviewedExceptNewest(keep: number): Promise<void>;
}

export interface IGroupStore {
    listGroupsSince(hours: number): Promise<IGroup[]>;
    groupedEntryIds(entryIds: string[]): Promise<string[]>;
    addToGroup(groupId: string | null, entry: IEntry): Promise<string>;
    saveSummary(groupId: string, summary: IGroupSummary, entryCount: number): Promise<void>;
}

export interface IGroupSummarizer {
    summarize(group: IGroup): Promise<IGroupSummary>;
}

export interface IFeedPublisher {
    publish(groups: IGroup[]): Promise<void>;
}

export interface IPromptLoader {
    load(): Promise<ICustomPrompt[]>;
}

export interface IReviewService {
    listPending(): Promise<IReviewItem[]>;
    submitReview(shownIds: string[], wrongIds: string[]): Promise<IReviewPrompt[]>;
    markReviewed(entryIds: string[]): Promise<void>;
    discardPending(keep: number): Promise<void>;
}

export const findPromptForCategory = (
    categoryTitle: string,
    prompts: ICustomPrompt[],
): ICustomPrompt | undefined =>
    prompts.find((p) => categoryTitle.toLowerCase().includes(p.category));

const filterCategoriesWithPrompts = (
    categories: ICategory[],
    prompts: ICustomPrompt[],
): ICategory[] =>
    categories.filter((c) =>
        prompts.some((p) => c.title.toLowerCase().includes(p.category)),
    );

const filterUnprocessedEntries = (
    entries: IEntry[],
    processedIds: string[],
    batchSize: number,
): IEntry[] =>
    entries.filter((e) => !processedIds.includes(e.id)).slice(0, batchSize);

const irrelevantEntryIds = (decisions: IDecision[]): string[] =>
    decisions.filter((d) => d.decision === "no").map((d) => d.entry.id);

const changedDecisionIds = (decisions: IDecision[], previous: IStoredDecision[]): string[] => {
    const before = new Map(previous.map((p) => [p.entryId, p.decision]));
    return decisions
        .filter((d) => before.has(d.entry.id) && before.get(d.entry.id) !== d.decision)
        .map((d) => d.entry.id);
};

const classifyOrSkip = async (
    classifier: IAIClassifier,
    entry: IEntry,
    prompts: ICustomPrompt[],
): Promise<IDecision | null> => {
    const prompt = findPromptForCategory(entry.feed.category.title, prompts);
    if (!prompt) throw new Error(`no prompt for category "${entry.feed.category.title}"`);
    try {
        return { entry, decision: (await classifier.classify(entry, prompt.content)) ? "yes" : "no" };
    } catch (err) {
        console.error(err);
        return null;
    }
};

export const run = async (
    feedReader: IFeedReader,
    promptLoader: IPromptLoader,
    classifier: IAIClassifier,
    entryUpdater: IEntryUpdater,
    database: IDatabase,
    processedIds: string[],
    batchSize: number,
): Promise<void> => {
    const prompts = await promptLoader.load();
    console.debug("customPrompts", prompts);

    const categories = await feedReader.getCategories();
    console.debug("categories", categories);

    const relevantCategories = filterCategoriesWithPrompts(categories, prompts);
    console.debug("categoriesWithPrompts", relevantCategories);

    const feeds = (
        await Promise.all(relevantCategories.map((c) => feedReader.getFeedsByCategory(c.id)))
    ).flat();
    console.debug("feeds", feeds);

    const unreadEntries = (
        await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
    ).flat();
    console.debug("unreadEntries", unreadEntries);

    const toVerify = filterUnprocessedEntries(unreadEntries, processedIds, batchSize);
    console.debug("unreadEntriesToVerify", toVerify);

    const decisions = (
        await Promise.all(toVerify.map((entry) => classifyOrSkip(classifier, entry, prompts)))
    ).filter((d): d is IDecision => d !== null);
    console.debug("aiDecisions", decisions);

    const toSkip = irrelevantEntryIds(decisions);
    const skipped = unreadEntries.filter((e) => toSkip.includes(e.id));
    console.debug("skipping", skipped.map((e) => e.title));

    const previous = await database.getDecisions(decisions.map((d) => d.entry.id));
    await database.saveDecisions(decisions);
    await database.resetVerdicts(changedDecisionIds(decisions, previous));
    if (toSkip.length > 0) await entryUpdater.markAsRead(toSkip);
    console.debug("skipped", skipped.map((e) => e.title));

    processedIds.push(...decisions.map((d) => d.entry.id));
};

const sameStoryPrompt = (group: IGroup): string =>
    `Is the article below about the same news story or event as "${group.summary?.title ?? group.entries[0].title}"? Answer yes or no.`;

const DIGEST_PROMPT =
    "Is the article below a digest that covers several separate news stories? Answer yes or no.";

export const runGrouping = async (
    feedReader: IFeedReader,
    classifier: IAIClassifier,
    entryUpdater: IEntryUpdater,
    groups: IGroupStore,
    summarizer: IGroupSummarizer,
    publisher: IFeedPublisher,
    categoryTitles: string[],
    windowHours: number,
    batchSize: number,
    digestIds: string[],
): Promise<void> => {
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
    await publisher.publish(published);
};

const SUBCATEGORY_SEPARATOR = " / ";

const parentCategory = (title: string): string =>
    title.split(SUBCATEGORY_SEPARATOR)[0];

const EXCERPT_LENGTH = 400;
const REVIEW_HISTORY_SIZE = 1000;

const toReviewItem = ({ content, ...rest }: IStoredDecision): IReviewItem => ({
    ...rest,
    excerpt: stripHtml(content).result.slice(0, EXCERPT_LENGTH),
});

const oppositeDecision = (decision: Decision): Decision =>
    decision === "yes" ? "no" : "yes";

const describeItem = (item: IReviewItem): string => {
    const correct =
        item.verdict === "wrong" ? oppositeDecision(item.decision) : item.decision;
    return [
        `- "${item.title}" (${item.url})`,
        `  classifier answered: ${item.decision} | correct answer: ${correct}`,
        `  excerpt: ${item.excerpt}`,
    ].join("\n");
};

const buildTweakPrompt = (prompt: string, items: IReviewItem[]): string => {
    const wrong = items.filter((i) => i.verdict === "wrong");
    const correct = items.filter((i) => i.verdict === "correct");
    return `I use an AI classifier to filter RSS articles. It receives the prompt below as instructions, plus an article title and body as input, and answers "yes" (relevant, keep unread) or "no" (irrelevant, mark as read).

I reviewed its decisions (up to the last ${REVIEW_HISTORY_SIZE} in this category and its subcategories). Please tweak the prompt so the classifier stops making the wrong decisions while keeping the correct ones. Return the full improved prompt, then a short list of what you changed and why.

<current_prompt>
${prompt}
</current_prompt>

## Wrong decisions (${wrong.length})
${wrong.map(describeItem).join("\n") || "none"}

## Correct decisions (${correct.length})
${correct.map(describeItem).join("\n") || "none"}
`;
};

export const makeReviewService = (
    database: IDatabase,
    promptLoader: IPromptLoader,
): IReviewService => ({
    listPending: async () =>
        (await database.listUnreviewedDecisions()).map(toReviewItem),

    submitReview: async (shownIds, wrongIds) => {
        const wrong = new Set(wrongIds);
        await database.saveVerdicts(
            shownIds.map((entryId) => ({
                entryId,
                verdict: wrong.has(entryId) ? "wrong" : "correct",
            })),
        );

        const shown = (await database.getDecisions(shownIds)).map(toReviewItem);
        const prompts = await promptLoader.load();
        const parents = [...new Set(shown.map((i) => parentCategory(i.category)))];
        const verdictCategories = await database.listVerdictCategories();

        const result = await Promise.all(parents.map(async (parent) => {
            const prompt = findPromptForCategory(parent, prompts);
            if (!prompt) return null;
            const history = (
                await database.listRecentVerdicts(
                    verdictCategories.filter((c) => parentCategory(c) === parent),
                    REVIEW_HISTORY_SIZE,
                )
            ).map(toReviewItem);
            return {
                category: parent,
                text: buildTweakPrompt(prompt.content, history),
                entryIds: shown.filter((i) => parentCategory(i.category) === parent).map((i) => i.entryId),
            };
        }));
        return result.filter((p): p is IReviewPrompt => p !== null);
    },

    markReviewed: (entryIds) => database.markReviewed(entryIds),

    discardPending: (keep) => database.discardUnreviewedExceptNewest(keep),
});
