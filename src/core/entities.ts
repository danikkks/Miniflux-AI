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

export type ISubscribedFeed = {
    id: string;
    url: string;
};

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

export interface IDecisionStore {
    getDecisions(entryIds: string[]): Promise<IStoredDecision[]>;
    saveDecisions(decisions: IDecision[]): Promise<void>;
    resetVerdicts(entryIds: string[]): Promise<void>;
}

export interface IReviewStore {
    listUnreviewedDecisions(): Promise<IStoredDecision[]>;
    getDecisions(entryIds: string[]): Promise<IStoredDecision[]>;
    listVerdictCategories(): Promise<string[]>;
    listRecentVerdicts(categories: string[], limit: number): Promise<IStoredDecision[]>;
    saveVerdicts(verdicts: IVerdict[]): Promise<void>;
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
    publish(groups: IGroup[]): Promise<boolean>;
    isPublishedAt(feedUrl: string): boolean;
}

export interface IFeedRefresher {
    listSubscribedFeeds(): Promise<ISubscribedFeed[]>;
    refreshFeed(feedId: string): Promise<void>;
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

const SUBCATEGORY_SEPARATOR = " / ";

export const parentCategory = (title: string): string =>
    title.split(SUBCATEGORY_SEPARATOR)[0];
