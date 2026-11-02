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
} from "./entities.js";

const filterCategoriesWithPrompts = (
    categories: ICategory[],
    prompts: ICustomPrompt[],
): ICategory[] =>
    categories.filter((c) =>
        prompts.some((p) => c.title.toLowerCase().includes(p.category)),
    );

export type EntryFilterDeps = {
    feedReader: IFeedReader;
    promptLoader: IPromptLoader;
    classifier: IAIClassifier;
    entryUpdater: IEntryUpdater;
    decisionStore: IDecisionStore;
    log: ILogger;
};

export const makeEntryFilter = ({
    feedReader,
    promptLoader,
    classifier,
    entryUpdater,
    decisionStore,
    log,
}: EntryFilterDeps): (() => Promise<void>) => {
    const processedIds: string[] = [];

    const classifyOrSkip = async (
        entry: IEntry,
        prompts: ICustomPrompt[],
        progress: string,
    ): Promise<IDecision | null> => {
        const prompt = findPromptForCategory(entry.feed.category.title, prompts);
        if (!prompt) throw new Error(`no prompt for category "${entry.feed.category.title}"`);
        log.debug("classifying entry %s", entry.id, entry);
        try {
            const decision = (await classifier.classify(entry, prompt.content)) ? "yes" : "no";
            log.info("%s entry %s \"%s\" -> %s", progress, entry.id, entry.title, decision === "yes" ? "relevant" : "irrelevant");
            return { entry, decision };
        } catch (err) {
            log.error("%s entry %s \"%s\" failed, retrying next run", progress, entry.id, entry.title, err);
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

        log.info(
            "%d prompts, %d categories, %d feeds",
            prompts.length, relevantCategories.length, feeds.length,
        );

        const handled = new Set<string>();
        const fetchUnprocessed = async (): Promise<IEntry[]> => {
            // TODO: entries left unread (relevant ones, failures) fill the miniflux 100 per feed window and can hide newer entries
            const unread = (
                await Promise.all(feeds.map((f) => feedReader.getUnreadEntries(f.id)))
            ).flat();
            return unread.filter((e) => !processedIds.includes(e.id) && !handled.has(e.id));
        };

        let relevant = 0;
        let irrelevant = 0;
        let failed = 0;
        for (let pending = await fetchUnprocessed(); pending.length > 0; pending = await fetchUnprocessed()) {
            log.info("%d to classify", pending.length);
            for (const [i, entry] of pending.entries()) {
                handled.add(entry.id);
                const decision = await classifyOrSkip(entry, prompts, `[${i + 1}/${pending.length}]`);
                if (!decision) {
                    failed++;
                    continue;
                }
                const previous = (await decisionStore.getDecisions([entry.id])).at(0);
                await decisionStore.saveDecisions([decision]);
                if (previous && previous.decision !== decision.decision) await decisionStore.resetVerdicts([entry.id]);
                if (decision.decision === "no") {
                    await entryUpdater.markAsRead([entry.id]);
                    irrelevant++;
                } else {
                    relevant++;
                }
                processedIds.push(entry.id);
            }
        }
        log.info(
            "run finished in %ss: %d relevant, %d irrelevant marked as read, %d failed",
            ((Date.now() - startedAt) / 1000).toFixed(1), relevant, irrelevant, failed,
        );
    };
};
