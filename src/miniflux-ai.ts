import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { readdir, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { stripHtml } from "string-strip-html";
import {
    type ICategory,
    type IFeed,
    type IEntry,
    type IFeedReader,
    type IAIClassifier,
    type IEntryUpdater,
    type IPromptLoader,
    run,
} from "./core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const minifluxHeaders = () =>
    new Headers({ "X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN });

const feedReader: IFeedReader = {
    getCategories: async () => {
        const r = await fetch(`${process.env.MINIFLUX_URL}/v1/categories`, {
            headers: minifluxHeaders(),
        });
        return r.json() as Promise<ICategory[]>;
    },

    getFeedsByCategory: async (categoryId) => {
        const r = await fetch(
            `${process.env.MINIFLUX_URL}/v1/categories/${categoryId}/feeds`,
            { headers: minifluxHeaders() },
        );
        return r.json() as Promise<IFeed[]>;
    },

    getUnreadEntries: async (feedId) => {
        const r = await fetch(
            `${process.env.MINIFLUX_URL}/v1/feeds/${feedId}/entries?status=unread&order=published_at&direction=asc&limit=100`,
            { headers: minifluxHeaders() },
        );
        const page = await (r.json() as Promise<{ entries: IEntry[] }>);
        return page.entries;
    },
};

const entryUpdater: IEntryUpdater = {
    markAsRead: async (entryIds) => {
        await fetch(`${process.env.MINIFLUX_URL}/v1/entries`, {
            method: "PUT",
            headers: minifluxHeaders(),
            body: JSON.stringify({ status: "read", entry_ids: entryIds }),
        });
    },
};

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
    const classifier = makeAIClassifier();
    const processedIds: string[] = [];
    const intervalMs =
        parseInt(process.env.PROCESSING_INTERVAL_SECONDS || "300") * 1000;
    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE);

    while (true) {
        try {
            await run(feedReader, promptLoader, classifier, entryUpdater, processedIds, batchSize);
        } catch (err) {
            console.error(err);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
})();
