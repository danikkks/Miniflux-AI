import { run, makeReviewService } from "./core.js";
import { makeMinifluxClient } from "./miniflux.js";
import { promptLoader } from "./prompt-loader.js";
import { makeAIClassifier } from "./ai-classifier.js";
import { makeSqliteDatabase } from "./sqlite-database.js";
import { startWebUi } from "./web-ui.js";

(async () => {
    const miniflux = makeMinifluxClient(
        process.env.MINIFLUX_URL,
        process.env.MINIFLUX_AUTH_TOKEN,
    );
    const classifier = makeAIClassifier();
    const database = makeSqliteDatabase(
        process.env.DATABASE_PATH || "miniflux-ai.db",
    );
    const processedIds: string[] = [];
    startWebUi(
        makeReviewService(database, promptLoader),
        parseInt(process.env.WEB_PORT || "3000"),
    );
    const intervalMs =
        parseInt(process.env.PROCESSING_INTERVAL_SECONDS || "300") * 1000;
    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE);

    while (true) {
        try {
            await run(miniflux, promptLoader, classifier, miniflux, database, processedIds, batchSize);
        } catch (err) {
            console.error(err);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
})();
