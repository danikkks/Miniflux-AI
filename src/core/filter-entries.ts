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
    ILogger,
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

export type EntryFilterDeps = {
    feedReader: IFeedReader;
    promptLoader: IPromptLoader;
    classifier: IAIClassifier;
    entryUpdater: IEntryUpdater;
    decisionStore: IDecisionStore;
    batchSize: number;
    log: ILogger;
};

export const makeEntryFilter = ({
    feedReader,
    promptLoader,
    classifier,
    entryUpdater,
    decisionStore,
    batchSize,
    log,
}: EntryFilterDeps): (() => Promise<void>) => {
    const processedIds: string[] = [];

    const classifyOrSkip = async (
        entry: IEntry,
        prompts: ICustomPrompt[],
        progress: () => string,
    ): Promise<IDecision | null> => {
        const prompt = findPromptForCategory(entry.feed.category.title, prompts);
        if (!prompt) throw new Error(`no prompt for category "${entry.feed.category.title}"`);
        log.debug("classifying entry %s", entry.id, entry);
        try {
            const decision = (await classifier.classify(entry, prompt.content)) ? "yes" : "no";
            log.info("%s entry %s \"%s\" -> %s", progress(), entry.id, entry.title, decision === "yes" ? "relevant" : "irrelevant");
            return { entry, decision };
        } catch (err) {
            log.error("%s entry %s \"%s\" failed, retrying next run", progress(), entry.id, entry.title, err);
            return null;
        }
    };

    return async () => {
        const startedAt = Date.now();
        log.info("run started");

        const prompts = await promptLoader.load();
        log.debug("custom prompts", prompts);

        const categories = await feedReader.getCategories();
        log.debug("categories", categories);

        const relevantCategories = filterCategoriesWithPrompts(categories, prompts);
        log.debug("categories with prompts", relevantCategories);

        const feeds = (
            await Promise.all(relevantCategories.map((c) => feedReader.getFeedsByCategory(c.id)))
        ).flat();
        log.debug("feeds", feeds);

        const unreadEntries = (
            await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
        ).flat();

        const toVerify = filterUnprocessedEntries(unreadEntries, processedIds, batchSize);
        log.info(
            "%d prompts, %d categories, %d feeds, %d unread entries, %d to classify",
            prompts.length, relevantCategories.length, feeds.length, unreadEntries.length, toVerify.length,
        );

        let done = 0;
        const progress = () => `[${++done}/${toVerify.length}]`;
        const decisions = (
            await Promise.all(toVerify.map((entry) => classifyOrSkip(entry, prompts, progress)))
        ).filter((d): d is IDecision => d !== null);

        const toSkip = irrelevantEntryIds(decisions);
        const previous = await decisionStore.getDecisions(decisions.map((d) => d.entry.id));
        await decisionStore.saveDecisions(decisions);
        await decisionStore.resetVerdicts(changedDecisionIds(decisions, previous));
        if (toSkip.length > 0) await entryUpdater.markAsRead(toSkip);

        processedIds.push(...decisions.map((d) => d.entry.id));
        log.info(
            "run finished in %ss: %d relevant, %d irrelevant marked as read, %d failed",
            ((Date.now() - startedAt) / 1000).toFixed(1),
            decisions.length - toSkip.length, toSkip.length, toVerify.length - decisions.length,
        );
    };
};
