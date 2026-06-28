import { run } from "./core.js";
import { makeMinifluxClient } from "./miniflux.js";
import { promptLoader } from "./prompt-loader.js";
import { makeAIClassifier } from "./ai-classifier.js";

(async () => {
    const miniflux = makeMinifluxClient(
        process.env.MINIFLUX_URL,
        process.env.MINIFLUX_AUTH_TOKEN,
    );
    const classifier = makeAIClassifier();
    const processedIds: string[] = [];
    const intervalMs =
        parseInt(process.env.PROCESSING_INTERVAL_SECONDS || "300") * 1000;
    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE);

    while (true) {
        try {
            await run(miniflux, promptLoader, classifier, miniflux, processedIds, batchSize);
        } catch (err) {
            console.error(err);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
})();
