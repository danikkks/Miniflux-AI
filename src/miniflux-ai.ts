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
    return Promise.all(
        files
            .filter((f) => f.startsWith("custom-prompt-") && f.endsWith(".md"))
            .map(async (f) => ({
                category: f.replace(/^custom-prompt-/, "").replace(/\.md$/, ""),
                content: await readFile(resolve(cwd, f), "utf8"),
            })),
    );
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

    const matchedCategories = categories.filter((c) =>
        prompts.some((p) => c.title.toLowerCase().includes(p.category)),
    );

    const feeds: { id: string; category: { title: string } }[] = (
        await Promise.all(
            matchedCategories.map((c) =>
                fetch(`${url}/v1/categories/${c.id}/feeds`, { headers }).then((r) => r.json()),
            ),
        )
    ).flat();

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

    const batchSize = parseInt(process.env.PROCESSING_BATCH_SIZE || "10");
    const newIds = new Set(storage.filterNewKeys(entries.map((e) => e.id)));
    const batch = entries.filter((e) => newIds.has(e.id)).slice(0, batchSize);

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

    storage.setMany(
        decisions
            .filter((d) => d.decision === "yes" || d.decision === "no")
            .map((d) => ({ key: d.id, value: d.decision })),
    );

    await fetch(`${url}/v1/entries`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
            status: "read",
            entry_ids: decisions.filter((d) => d.decision.toLowerCase().includes("no")).map((d) => d.id),
        }),
    });

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
