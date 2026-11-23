import { findPromptForCategory, NO_PROBABILITY, YES_PROBABILITY } from "./entities.js";
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
    IRunLogger,
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
    log: IRunLogger;
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
        progress: { index: number; total: number },
    ): Promise<IDecision | null> => {
        const prompt = findPromptForCategory(entry.feed.category.title, prompts);
        if (!prompt) throw new Error(`no prompt for category "${entry.feed.category.title}"`);
        log.debug("classifying entry %s", entry.id, entry);
        try {
            const probability = await classifier.classify(entry, prompt.content);
            const decision = probability < NO_PROBABILITY ? "no" : "yes";
            const type = decision === "no" ? "entry-irrelevant" : probability >= YES_PROBABILITY ? "entry-relevant" : "entry-unsure";
            log.info({ type, ...progress, entryId: entry.id, title: entry.title });
            return { entry, decision };
        } catch (err) {
            log.error({ type: "entry-failed", ...progress, entryId: entry.id, title: entry.title }, err);
            return null;
        }
    };

    return async () => {
        const startedAt = Date.now();
        log.info({ type: "run-started" });

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

        log.info({ type: "filter-scope", prompts: prompts.length, categories: relevantCategories.length, feeds: feeds.length });

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
            log.info({ type: "to-classify", count: pending.length });
            for (const [i, entry] of pending.entries()) {
                handled.add(entry.id);
                const decision = await classifyOrSkip(entry, prompts, { index: i + 1, total: pending.length });
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
        log.info({ type: "filter-finished", seconds: Math.round((Date.now() - startedAt) / 100) / 10, relevant, irrelevant, failed });
    };
};
