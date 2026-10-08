import { stripHtml } from "string-strip-html";

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

export type Verdict = "correct" | "wrong";

export type IStoredDecision = {
    entryId: string;
    title: string;
    url: string;
    content: string;
    category: string;
    decision: string;
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
    listUnreviewedDecisions(): Promise<IStoredDecision[]>;
    getDecisions(entryIds: string[]): Promise<IStoredDecision[]>;
    listRecentVerdicts(category: string, limit: number): Promise<IStoredDecision[]>;
    saveVerdicts(verdicts: IVerdict[]): Promise<void>;
    markReviewed(entryIds: string[]): Promise<void>;
}

export interface IPromptLoader {
    load(): Promise<ICustomPrompt[]>;
}

export interface IReviewService {
    listPending(): Promise<IReviewItem[]>;
    submitReview(shownIds: string[], wrongIds: string[]): Promise<IReviewPrompt[]>;
    markReviewed(entryIds: string[]): Promise<void>;
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
            const prompt = findPromptForCategory(entry.feed.category.title, prompts);
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

const EXCERPT_LENGTH = 400;
const REVIEW_HISTORY_SIZE = 1000;

const toReviewItem = ({ content, ...rest }: IStoredDecision): IReviewItem => ({
    ...rest,
    excerpt: stripHtml(content).result.slice(0, EXCERPT_LENGTH),
});

const oppositeDecision = (decision: string): string =>
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

I reviewed its decisions (up to the last ${REVIEW_HISTORY_SIZE} in this category). Please tweak the prompt so the classifier stops making the wrong decisions while keeping the correct ones. Return the full improved prompt, then a short list of what you changed and why.

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
        const categories = [...new Set(shown.map((i) => i.category))];

        const result = await Promise.all(categories.map(async (category) => {
            const prompt = findPromptForCategory(category, prompts);
            if (!prompt) return null;
            const history = (
                await database.listRecentVerdicts(category, REVIEW_HISTORY_SIZE)
            ).map(toReviewItem);
            return {
                category,
                text: buildTweakPrompt(prompt.content, history),
                entryIds: shown.filter((i) => i.category === category).map((i) => i.entryId),
            };
        }));
        return result.filter((p): p is IReviewPrompt => p !== null);
    },

    markReviewed: (entryIds) => database.markReviewed(entryIds),
});
