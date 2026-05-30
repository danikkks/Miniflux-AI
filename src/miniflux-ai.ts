import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { readdir, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { stripHtml } from "string-strip-html";
import {
    type IAIClassifier,
    type IPromptLoader,
    run,
} from "./core.js";
import { makeMinifluxClient } from "./miniflux.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const promptLoader: IPromptLoader = {
    load: async () => {
        const files = await readdir(__dirname);
        const promptFiles = files.filter(
            (f) => f.startsWith("custom-prompt-") && f.endsWith(".md"),
        );
        const contents = await Promise.all(
            promptFiles.map((f) =>
                readFile(resolve(__dirname, f), { encoding: "utf8" }),
            ),
        );
        return contents.map((content, i) => ({
            category: promptFiles[i]
                .replace(/^custom-prompt-/, "")
                .replace(/\.md$/, ""),
            content,
        }));
    },
};

const makeAIClassifier = (): IAIClassifier => {
    if (process.env.AI_PROVIDER === "OPENAI") {
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
        return {
            classify: async (entry, prompt) => {
                const r = await client.responses.create({
                    model: "gpt-5-nano",
                    instructions: prompt,
                    input: `# ${entry.title}\n${entry.content}`,
                });
                return r.output_text;
            },
        };
    }

    const client = new Ollama({ host: process.env.OLLAMA_BASE_URL });
    return {
        classify: async (entry, prompt) => {
            const r = await client.generate({
                model: process.env.OLLAMA_MODEL,
                prompt: `${prompt}\n\n ${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? "" : stripHtml(entry.content).result}`,
                think: true,
            });
            return r.response;
        },
    };
};

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
