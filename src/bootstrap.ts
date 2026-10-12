import { run, runGrouping, makeReviewService } from "./core.js";
import { makeMinifluxClient } from "./miniflux.js";
import { promptLoader } from "./prompt-loader.js";
import { makeAIClassifier } from "./ai-classifier.js";
import { makeSqliteDatabase, makeSqliteGroupStore } from "./sqlite-database.js";
import { makeAISummarizer } from "./ai-summarizer.js";
import { makeB2FeedPublisher } from "./b2-feed-publisher.js";
import { startWebUi } from "./web-ui.js";

const loop = async (intervalMs: number, task: () => Promise<void>): Promise<never> => {
    while (true) {
        try {
            await task();
        } catch (err) {
            console.error(err);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
};

(async () => {
    const miniflux = makeMinifluxClient(
        process.env.MINIFLUX_URL,
        process.env.MINIFLUX_AUTH_TOKEN,
    );
    const classifier = makeAIClassifier();
    const databasePath = process.env.DATABASE_PATH || "miniflux-ai.db";
    const database = makeSqliteDatabase(databasePath);
    const processedIds: string[] = [];
    startWebUi(
        makeReviewService(database, promptLoader),
        parseInt(process.env.WEB_PORT || "3000"),
    );
    const intervalMs =
        parseInt(process.env.PROCESSING_INTERVAL_SECONDS || "300") * 1000;
    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE) || Infinity;

    // grouping (with summaries) comes before filtering
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
        const summarizer = makeAISummarizer(process.env.OLLAMA_BASE_URL, summaryModel);
        const publisher = makeB2FeedPublisher({
            endpoint: process.env.B2_ENDPOINT,
            region: process.env.B2_REGION,
            bucket: process.env.B2_BUCKET,
            keyId: process.env.B2_KEY_ID,
            applicationKey: process.env.B2_APPLICATION_KEY,
            objectKey: process.env.GROUPED_FEED_KEY || "grouped.xml",
            feedTitle: process.env.GROUPED_FEED_TITLE || "Grouped articles",
            feedLink: process.env.MINIFLUX_URL,
        });
        const digestIds: string[] = [];
        const windowHours = parseInt(process.env.GROUPING_WINDOW_HOURS || "48");
        steps.push(() =>
            runGrouping(miniflux, classifier, miniflux, groups, summarizer, publisher, groupingCategories, windowHours, batchSize, digestIds),
        );
    }
    steps.push(() =>
        run(miniflux, promptLoader, classifier, miniflux, database, processedIds, batchSize),
    );

    if (process.env.RUN_SEQUENTIALLY === "true") {
        // one model in ollama memory at a time: a failing step must not block the next
        await loop(intervalMs, async () => {
            for (const step of steps) {
                try {
                    await step();
                } catch (err) {
                    console.error(err);
                }
            }
        });
    } else {
        await Promise.all(steps.map((step) => loop(intervalMs, step)));
    }
})();
