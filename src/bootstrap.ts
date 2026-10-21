import { makeEntryFilter } from "./core/filter-entries.js";
import { makeStoryGrouper } from "./core/group-stories.js";
import { makeReviewService } from "./core/review-decisions.js";
import { makeMinifluxClient } from "./miniflux.js";
import { makePromptLoader } from "./prompt-loader.js";
import { makeAIClassifier } from "./ai-classifier.js";
import { makeSqliteDatabase, makeSqliteGroupStore } from "./sqlite-database.js";
import { makeAISummarizer } from "./ai-summarizer.js";
import { makeB2FeedPublisher } from "./b2-feed-publisher.js";
import { startWebUi } from "./web-ui.js";
import type { IProcessing, ProcessingStatus } from "./core/entities.js";

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
};

const trackRuns = (task: () => Promise<void>): IProcessing => {
    let running: Promise<void> | null = null;
    let lastFailed: boolean | null = null;
    return {
        run: () => (running ??= task()
            .then(
                () => { lastFailed = false; },
                (err: unknown) => {
                    console.error(err);
                    lastFailed = true;
                },
            )
            .finally(() => { running = null; })),
        status: () => {
            if (running) return "running";
            if (lastFailed === null) return "idle";
            return lastFailed ? "failed" : "completed";
        },
    };
};

const STATUS_PRECEDENCE: ProcessingStatus[] = ["running", "failed", "completed", "idle"];

const trackInParallel = (runs: IProcessing[]): IProcessing => ({
    run: async () => {
        await Promise.all(runs.map((r) => r.run()));
    },
    status: () => {
        const statuses = runs.map((r) => r.status());
        return STATUS_PRECEDENCE.find((s) => statuses.includes(s)) ?? "idle";
    },
});

const runInOrder = async (tasks: (() => Promise<void>)[]): Promise<void> => {
    const errors: unknown[] = [];
    for (const task of tasks) {
        try {
            await task();
        } catch (err) {
            errors.push(err);
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, "processing failed");
};

const loop = async (intervalMs: number, task: () => Promise<void>): Promise<never> => {
    for (;;) {
        await task();
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
};

void (async () => {
    const miniflux = makeMinifluxClient(
        requireEnv("MINIFLUX_URL"),
        requireEnv("MINIFLUX_AUTH_TOKEN"),
    );
    const classifier = makeAIClassifier({
        useOpenAI: process.env.AI_PROVIDER === "OPENAI",
        openaiApiKey: process.env.OPENAI_API_KEY || "",
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
        ollamaModel: process.env.OLLAMA_MODEL,
        useDecisionApi: process.env.OLLAMA_DECISION_API === "true",
    });
    const promptLoader = makePromptLoader(process.cwd());
    const databasePath = process.env.DATABASE_PATH || "miniflux-ai.db";
    const database = makeSqliteDatabase(databasePath);
    const intervalMs =
        parseInt(process.env.PROCESSING_INTERVAL_SECONDS || "300") * 1000;
    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE ?? "") || Infinity;

    const steps: (() => Promise<void>)[] = [];

    const groupingCategories = (process.env.GROUPING_CATEGORIES || "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    const decisionApi = process.env.AI_PROVIDER !== "OPENAI" && process.env.OLLAMA_DECISION_API === "true";
    const summaryModel = process.env.OLLAMA_SUMMARY_MODEL;
    const b2Configured = ["B2_ENDPOINT", "B2_REGION", "B2_BUCKET", "B2_KEY_ID", "B2_APPLICATION_KEY"].every((v) => process.env[v]);
    const groupingEnabled = decisionApi && Boolean(summaryModel) && b2Configured;
    if (groupingCategories.length > 0 && !groupingEnabled) {
        console.warn("grouping is disabled: it requires OLLAMA_DECISION_API=true, OLLAMA_SUMMARY_MODEL and all B2_* variables");
    }
    if (groupingCategories.length > 0 && groupingEnabled) {
        const groups = makeSqliteGroupStore(databasePath);
        const summarizer = makeAISummarizer(requireEnv("OLLAMA_BASE_URL"), requireEnv("OLLAMA_SUMMARY_MODEL"));
        const publisher = makeB2FeedPublisher({
            endpoint: requireEnv("B2_ENDPOINT"),
            region: requireEnv("B2_REGION"),
            bucket: requireEnv("B2_BUCKET"),
            keyId: requireEnv("B2_KEY_ID"),
            applicationKey: requireEnv("B2_APPLICATION_KEY"),
            objectKey: process.env.GROUPED_FEED_KEY || "grouped.xml",
            feedTitle: process.env.GROUPED_FEED_TITLE || "Grouped articles",
            feedLink: requireEnv("MINIFLUX_URL"),
        });
        const windowHours = parseInt(process.env.GROUPING_WINDOW_HOURS || "48");
        steps.push(makeStoryGrouper({
            feedReader: miniflux,
            classifier,
            entryUpdater: miniflux,
            groups,
            summarizer,
            publisher,
            feedRefresher: miniflux,
            categoryTitles: groupingCategories,
            windowHours,
            batchSize,
        }));
    }
    steps.push(makeEntryFilter({
        feedReader: miniflux,
        promptLoader,
        classifier,
        entryUpdater: miniflux,
        decisionStore: database,
        batchSize,
    }));

    const loops = process.env.RUN_SEQUENTIALLY === "true"
        ? [trackRuns(() => runInOrder(steps))]
        : steps.map(trackRuns);
    startWebUi(
        makeReviewService(database, promptLoader),
        trackInParallel(loops),
        parseInt(process.env.WEB_PORT || "3000"),
    );
    await Promise.all(loops.map((l) => loop(intervalMs, () => l.run())));
})();
