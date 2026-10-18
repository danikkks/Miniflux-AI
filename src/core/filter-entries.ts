import { findPromptForCategory } from "./entities.js";
import type {
    ICategory,
    ICustomPrompt,
    IAIClassifier,
    IDecision,
    IDecisionStore,
    IEntry,
    IEntryUpdater,
    IFeedReader,
    IPromptLoader,
    IStoredDecision,
} from "./entities.js";

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

export type EntryFilterDeps = {
    feedReader: IFeedReader;
    promptLoader: IPromptLoader;
    classifier: IAIClassifier;
    entryUpdater: IEntryUpdater;
    decisionStore: IDecisionStore;
    batchSize: number;
};

export const makeEntryFilter = ({
    feedReader,
    promptLoader,
    classifier,
    entryUpdater,
    decisionStore,
    batchSize,
}: EntryFilterDeps): (() => Promise<void>) => {
    const processedIds: string[] = [];

    return async () => {
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

        const previous = await decisionStore.getDecisions(decisions.map((d) => d.entry.id));
        await decisionStore.saveDecisions(decisions);
        await decisionStore.resetVerdicts(changedDecisionIds(decisions, previous));
        if (toSkip.length > 0) await entryUpdater.markAsRead(toSkip);
        console.debug("skipped", skipped.map((e) => e.title));

        processedIds.push(...decisions.map((d) => d.entry.id));
    };
};
