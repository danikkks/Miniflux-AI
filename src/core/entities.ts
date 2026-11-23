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

export const NO_PROBABILITY = 0.3;
export const YES_PROBABILITY = 0.5;

export type IReference = { title: string; content: string };

export type ICriteria = { true: string; false: string };

export interface IAIClassifier {
    classify(entry: IEntry, prompt: string, criteria?: ICriteria, reference?: IReference): Promise<number>;
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

export interface ILogger {
    info(message: string, ...details: unknown[]): void;
    debug(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
}

export type ProcessingStatus = "idle" | "running" | "completed" | "failed";

type EntryProgress = { index: number; total: number; entryId: string; title: string };

type GroupProgress = { index: number; total: number; groupId: string };

export type RunEvent =
    | { type: "run-started" }
    | { type: "run-failed" }
    | { type: "filter-scope"; prompts: number; categories: number; feeds: number }
    | { type: "to-classify"; count: number }
    | ({ type: "entry-relevant" | "entry-irrelevant" | "entry-unsure" } & EntryProgress)
    | ({ type: "entry-failed" } & EntryProgress)
    | { type: "filter-finished"; seconds: number; relevant: number; irrelevant: number; failed: number }
    | { type: "group-scope"; categories: number; feeds: number; openGroups: number }
    | { type: "stale-marked-read"; count: number }
    | { type: "stale-mark-failed" }
    | { type: "fetch-failed" }
    | { type: "to-group"; count: number }
    | ({ type: "entry-digest" } & EntryProgress)
    | ({ type: "entry-not-news" } & EntryProgress)
    | ({ type: "entry-grouped"; groupId: string; groupTitle: string } & EntryProgress)
    | ({ type: "group-started"; groupId: string } & EntryProgress)
    | { type: "summarizing"; count: number }
    | ({ type: "group-summarized"; summaryTitle: string } & GroupProgress)
    | ({ type: "summary-failed" } & GroupProgress)
    | { type: "feed-published"; groups: number }
    | { type: "feeds-refreshed"; count: number }
    | { type: "feed-unchanged" }
    | { type: "group-finished"; seconds: number; grouped: number; failed: number };

export interface IRunLogger {
    info(event: RunEvent): void;
    error(event: RunEvent, err: unknown): void;
    debug(message: string, ...details: unknown[]): void;
}

export type RunLogRecord = RunEvent & { time: string; level: "INFO" | "ERROR"; process: string; error?: string };

export interface IRunProgress {
    name: string;
    records: RunLogRecord[];
}

export interface IProcessing {
    run(): Promise<void>;
    status(): ProcessingStatus;
    progress(): IRunProgress[];
}

export const findPromptForCategory = (
    categoryTitle: string,
    prompts: ICustomPrompt[],
): ICustomPrompt | undefined =>
    prompts.find((p) => categoryTitle.toLowerCase().includes(p.category));

const SUBCATEGORY_SEPARATOR = " / ";

export const parentCategory = (title: string): string =>
    title.split(SUBCATEGORY_SEPARATOR)[0];
