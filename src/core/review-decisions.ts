import { stripHtml } from "string-strip-html";
import { findPromptForCategory, parentCategory } from "./entities.js";
import type {
    Decision,
    IPromptLoader,
    IReviewItem,
    IReviewPrompt,
    IReviewService,
    IReviewStore,
    IStoredDecision,
} from "./entities.js";

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
    database: IReviewStore,
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
