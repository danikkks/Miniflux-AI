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
import { makeLogs, type Logs } from "./logger.js";
import { ENGLISH_TEMPLATES } from "./log-templates.js";
import { makeFetchWithRetry } from "./fetch-with-retry.js";
import type { IProcessing, ProcessingStatus } from "./core/entities.js";

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
};

type Step = { name: string; run: () => Promise<void> };

const trackRuns = (logs: Logs, name: string, task: () => Promise<void>): IProcessing => {
    const log = logs.runLogger(name);
    let running: Promise<void> | null = null;
    let lastFailed: boolean | null = null;
    const start = () => {
        logs.startRun(name);
        return task();
    };
    return {
        run: () => (running ??= start()
            .then(
                () => { lastFailed = false; },
                (err: unknown) => {
                    log.error({ type: "run-failed" }, err);
                    lastFailed = true;
                },
            )
            .finally(() => { running = null; })),
        status: () => {
            if (running) return "running";
            if (lastFailed === null) return "idle";
            return lastFailed ? "failed" : "completed";
        },
        progress: () => [{ name, records: logs.records(name) }],
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
    progress: () => runs.flatMap((r) => r.progress()),
});

const runInOrder = async (steps: Step[]): Promise<void> => {
    const errors: unknown[] = [];
    const failed: string[] = [];
    for (const step of steps) {
        try {
            await step.run();
        } catch (err) {
            errors.push(err);
            failed.push(step.name);
        }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${failed.join(", ")} failed`);
};

process.on("SIGTERM", () => process.exit(0));

const logs = makeLogs(process.env.LOG_DIR || "logs", process.env.LOGGING_LEVEL === "debug", ENGLISH_TEMPLATES);
const appLog = logs.logger("app");
const sequential = process.env.RUN_SEQUENTIALLY === "true";
const stepLog = (name: string) => logs.runLogger(name, sequential ? "processing" : name);
const fetchWithRetry = makeFetchWithRetry(logs.logger("http"));
const miniflux = makeMinifluxClient(
    requireEnv("MINIFLUX_URL"),
    requireEnv("MINIFLUX_AUTH_TOKEN"),
    fetchWithRetry,
);
const classifier = makeAIClassifier(process.env.OLLAMA_BASE_URL, requireEnv("OLLAMA_MODEL"), fetchWithRetry);
const promptLoader = makePromptLoader(process.cwd());
const databasePath = process.env.DATABASE_PATH || "miniflux-ai.db";
const database = makeSqliteDatabase(databasePath);

const steps: Step[] = [];

const groupingCategories = (process.env.GROUPING_CATEGORIES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
const summaryModel = process.env.OLLAMA_SUMMARY_MODEL;
const b2Configured = ["B2_ENDPOINT", "B2_REGION", "B2_BUCKET", "B2_KEY_ID", "B2_APPLICATION_KEY"].every((v) => process.env[v]);
const groupingEnabled = Boolean(summaryModel) && b2Configured;
if (groupingCategories.length > 0 && !groupingEnabled) {
    appLog.info("grouping is disabled: it requires OLLAMA_SUMMARY_MODEL and all B2_* variables");
}
if (groupingCategories.length > 0 && groupingEnabled) {
    const groups = makeSqliteGroupStore(databasePath);
    const summarizer = makeAISummarizer(requireEnv("OLLAMA_BASE_URL"), requireEnv("OLLAMA_SUMMARY_MODEL"), fetchWithRetry);
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
    steps.push({ name: "grouping", run: makeStoryGrouper({
        feedReader: miniflux,
        classifier,
        entryUpdater: miniflux,
        groups,
        summarizer,
        publisher,
        feedRefresher: miniflux,
        categoryTitles: groupingCategories,
        windowHours,
        log: stepLog("grouping"),
    }) });
}
steps.push({ name: "filtering", run: makeEntryFilter({
    feedReader: miniflux,
    promptLoader,
    classifier,
    entryUpdater: miniflux,
    decisionStore: database,
    log: stepLog("filtering"),
}) });

const runs = sequential
    ? [trackRuns(logs, "processing", () => runInOrder(steps))]
    : steps.map((s) => trackRuns(logs, s.name, s.run));
const port = parseInt(process.env.WEB_PORT || "3000");
startWebUi(
    makeReviewService(database, promptLoader),
    trackInParallel(runs),
    ENGLISH_TEMPLATES,
    port,
    logs.logger("web"),
);
appLog.info(
    "started: %s run when triggered from the review ui on port %d",
    steps.map((s) => s.name).join(sequential ? " then " : " and "), port,
);
