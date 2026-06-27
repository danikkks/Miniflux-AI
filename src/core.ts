export type ICategory = {
    id: string;
    title: string;
    user_id: number;
    hide_globally: boolean;
};

export type IFeed = {
    id: string;
    category: ICategory;
};

export type IEntry = {
    id: string;
    title: string;
    content: string;
    feed: IFeed;
};

type IDecision = {
    entryId: string;
    decision: string;
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
    classify(entry: IEntry, prompt: string): Promise<string>;
}

export interface IEntryUpdater {
    markAsRead(entryIds: string[]): Promise<void>;
}

export interface IPromptLoader {
    load(): Promise<ICustomPrompt[]>;
}

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

const findPromptForEntry = (
    entry: IEntry,
    prompts: ICustomPrompt[],
): ICustomPrompt | undefined =>
    prompts.find((p) =>
        entry.feed.category.title.toLowerCase().includes(p.category),
    );

const irrelevantEntryIds = (decisions: IDecision[]): string[] =>
    decisions
        .filter((d) => d.decision.toLowerCase().trim() === "no")
        .map((d) => d.entryId);

const decidedEntryIds = (decisions: IDecision[]): string[] =>
    decisions
        .filter((d) => d.decision === "yes" || d.decision === "no")
        .map((d) => d.entryId);

export const run = async (
    feedReader: IFeedReader,
    promptLoader: IPromptLoader,
    classifier: IAIClassifier,
    entryUpdater: IEntryUpdater,
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

    const decisions: IDecision[] = await Promise.all(
        toVerify.map(async (entry) => {
            const prompt = findPromptForEntry(entry, prompts);
            return {
                entryId: entry.id,
                decision: await classifier.classify(entry, prompt.content),
            };
        }),
    );
    console.debug("aiDecisions", decisions);

    const toSkip = irrelevantEntryIds(decisions);
    console.debug("skipping", unreadEntries.filter((e) => toSkip.includes(e.id)).map((e) => e.title));

    await entryUpdater.markAsRead(toSkip);
    console.debug("skipped", unreadEntries.filter((e) => toSkip.includes(e.id)).map((e) => e.title));

    processedIds.push(...decidedEntryIds(decisions));
};
