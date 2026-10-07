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
    url: string;
    content: string;
    feed: IFeed;
};

export type IDecision = {
    entry: IEntry;
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

export interface IDatabase {
    saveDecisions(decisions: IDecision[]): Promise<void>;
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
        .map((d) => d.entry.id);

const validDecisions = (decisions: IDecision[]): IDecision[] =>
    decisions.filter((d) => d.decision === "yes" || d.decision === "no");

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

    const decisions: IDecision[] = await Promise.all(
        toVerify.map(async (entry) => {
            const prompt = findPromptForEntry(entry, prompts);
            return {
                entry,
                decision: await classifier.classify(entry, prompt.content),
            };
        }),
    );
    console.debug("aiDecisions", decisions);

    const toSkip = irrelevantEntryIds(decisions);
    const skipped = unreadEntries.filter((e) => toSkip.includes(e.id));
    console.debug("skipping", skipped.map((e) => e.title));

    const valid = validDecisions(decisions);
    await database.saveDecisions(valid);
    await entryUpdater.markAsRead(toSkip);
    console.debug("skipped", skipped.map((e) => e.title));

    processedIds.push(...valid.map((d) => d.entry.id));
};
