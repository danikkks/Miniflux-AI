import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { readdir, readFile } from "fs/promises";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { stripHtml } from "string-strip-html";
import { createStorage } from "./storage.js";

type CustomPrompt = { category: string; content: string };

async function loadPrompts(cwd: string): Promise<CustomPrompt[]> {
    const files = await readdir(cwd);
    const prompts = await Promise.all(
        files
            .filter((f) => f.startsWith("custom-prompt-") && f.endsWith(".md"))
            .map(async (f) => ({
                category: f.replace(/^custom-prompt-/, "").replace(/\.md$/, ""),
                content: await readFile(resolve(cwd, f), "utf8"),
            })),
    );
    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`customPromptContent: ${JSON.stringify(prompts, null, 2)}`);
    return prompts;
}

async function runCycle(
    prompts: CustomPrompt[],
    storage: ReturnType<typeof createStorage>,
    ollama: Ollama,
    openai: OpenAI,
): Promise<number> {
    const url = process.env.MINIFLUX_URL!;
    const headers = new Headers({ "X-Auth-Token": process.env.MINIFLUX_AUTH_TOKEN! });

    const categories: { id: string; title: string }[] = await fetch(
        `${url}/v1/categories`,
        { headers },
    ).then((r) => r.json());

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`categories: ${JSON.stringify(categories, null, 2)}`);

    const matchedCategories = categories.filter((c) =>
        prompts.some((p) => c.title.toLowerCase().includes(p.category)),
    );

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`categoriesWithPrompts: ${JSON.stringify(matchedCategories, null, 2)}`);

    const feeds: { id: string; category: { title: string } }[] = (
        await Promise.all(
            matchedCategories.map((c) =>
                fetch(`${url}/v1/categories/${c.id}/feeds`, { headers }).then((r) => r.json()),
            ),
        )
    ).flat();

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`feeds: ${JSON.stringify(feeds, null, 2)}`);

    const entries: { id: string; title: string; content: string; feed: { category: { title: string } } }[] = (
        await Promise.all(
            feeds.map((f) =>
                fetch(
                    `${url}/v1/feeds/${f.id}/entries?status=unread&order=published_at&direction=asc&limit=100`,
                    { headers },
                ).then((r) => r.json()),
            ),
        )
    ).flatMap((page: { entries: any[] }) => page.entries);

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`unreadEntries: ${JSON.stringify(entries, null, 2)}`);

    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE || "10");
    const newIds = new Set(storage.filterNewKeys(entries.map((e) => e.id)));
    const batch = entries.filter((e) => newIds.has(e.id)).slice(0, batchSize);

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`unreadEntriesToVerify: ${JSON.stringify(batch, null, 2)}`);

    const decisions = await Promise.all(
        batch.map(async (entry) => {
            const prompt = prompts.find((p) =>
                entry.feed.category.title.toLowerCase().includes(p.category),
            )!.content;

            if (process.env.AI_PROVIDER === "OPENAI") {
                const res = await openai.responses.create({
                    model: "gpt-5-nano",
                    instructions: prompt,
                    input: `# ${entry.title}\n${entry.content}`,
                });
                return { id: entry.id, decision: res.output_text };
            } else {
                const res = await ollama.generate({
                    model: process.env.OLLAMA_MODEL ?? "",
                    prompt: `${prompt}\n\n\ ${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? "" : stripHtml(entry.content).result}`,
                    think: true,
                });
                return { id: entry.id, decision: res.response };
            }
        }),
    );

    if (process.env.LOGGING_LEVEL === "debug")
        console.debug(`aiDecisions: ${JSON.stringify(decisions, null, 2)}`);

    const irrelevantEntryIds = decisions
        .filter((d) => d.decision.toLowerCase().includes("no"))
        .map((d) => d.id);

    storage.setMany(
        irrelevantEntryIds.map((id) => ({ key: id, value: "no" })),
    );

    if (process.env.LOGGING_LEVEL === "debug") {
        console.debug(
            `Attempting to skip the following entries:\n${entries
                .filter((e) => irrelevantEntryIds.includes(e.id))
                .map((e) => `- ${e.title}`)
                .join("\n")}`,
        );
    }

    await fetch(`${url}/v1/entries`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
            status: "read",
            entry_ids: irrelevantEntryIds,
        }),
    });

    if (process.env.LOGGING_LEVEL === "debug") {
        console.debug(
            `Successfully skipped the following entries:\n${entries
                .filter((e) => irrelevantEntryIds.includes(e.id))
                .map((e) => `- ${e.title}`)
                .join("\n")}`,
        );
    }

    return batch.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ollama = new Ollama({ host: process.env.OLLAMA_BASE_URL });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
    const storage = createStorage(process.cwd());
    const prompts = await loadPrompts(process.cwd());

    if (process.argv.includes("--watch")) {
        const intervalArg = process.argv.find((a) => a.startsWith("--interval="));
        const intervalMs = intervalArg ? parseFloat(intervalArg.split("=")[1]) * 1000 : 60_000;

        let running = false;
        const tick = async () => {
            if (running) return;
            running = true;
            try {
                while ((await runCycle(prompts, storage, ollama, openai)) > 0) {}
            } catch (e) {
                console.error(e);
            } finally {
                running = false;
            }
        };
        await tick();
        setInterval(tick, intervalMs);
    } else {
        try {
            while ((await runCycle(prompts, storage, ollama, openai)) > 0) {}
        } catch (e) {
            console.error(e);
            process.exit(1);
        }
    }
}
