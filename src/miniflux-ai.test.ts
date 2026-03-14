import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcess } from "child_process";
import * as http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "miniflux-ai.js");
const TECH_PROMPT =
    "Reply with 'yes' if relevant to software engineering, otherwise 'no'.";

// ---------------------------------------------------------------------------
// Mock types and factories
// ---------------------------------------------------------------------------

type MockEntry = {
    id: string;
    title: string;
    content: string;
    categoryId: string;
    categoryTitle: string;
};

type MockState = {
    entries: MockEntry[];
    aiDecision: (prompt: string) => string;
    markedAsRead: string[];
    onPut?: () => void;
};

function makeEntry(
    id: string,
    title: string,
    content: string,
    categoryId: string,
    categoryTitle: string,
): MockEntry {
    return { id, title, content, categoryId, categoryTitle };
}

function createState(
    entries: MockEntry[],
    aiDecision: (prompt: string) => string,
): MockState {
    return { entries, aiDecision, markedAsRead: [] };
}

// ---------------------------------------------------------------------------
// Mock HTTP servers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => resolve(body));
    });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}

function createMinifluxHandler(state: MockState) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        if (method === "GET" && url === "/v1/categories") {
            const seen = new Set<string>();
            const categories = state.entries
                .filter((e) => {
                    if (seen.has(e.categoryId)) return false;
                    seen.add(e.categoryId);
                    return true;
                })
                .map((e) => ({
                    id: e.categoryId,
                    title: e.categoryTitle,
                    user_id: 1,
                    hide_globally: false,
                }));
            return jsonResponse(res, categories);
        }

        const catFeedsMatch = url.match(/^\/v1\/categories\/([^/]+)\/feeds$/);
        if (method === "GET" && catFeedsMatch) {
            const catId = catFeedsMatch[1];
            const cat = state.entries.find((e) => e.categoryId === catId);
            if (!cat) return jsonResponse(res, [], 404);
            return jsonResponse(res, [
                { id: `feed-${catId}`, category: { id: catId, title: cat.categoryTitle } },
            ]);
        }

        const feedEntriesMatch = url.match(/^\/v1\/feeds\/([^/?]+)\/entries/);
        if (method === "GET" && feedEntriesMatch) {
            const feedId = feedEntriesMatch[1];
            const catId = feedId.replace(/^feed-/, "");
            const feedEntries = state.entries
                .filter((e) => e.categoryId === catId)
                .map((e) => ({
                    id: e.id,
                    title: e.title,
                    content: e.content,
                    feed: {
                        id: feedId,
                        category: { id: e.categoryId, title: e.categoryTitle },
                    },
                }));
            return jsonResponse(res, { total: feedEntries.length, entries: feedEntries });
        }

        if (method === "PUT" && url === "/v1/entries") {
            const body = JSON.parse(await readBody(req));
            state.markedAsRead.push(...body.entry_ids);
            state.onPut?.();
            return jsonResponse(res, {});
        }

        jsonResponse(res, { error: "not found" }, 404);
    };
}

function createAiHandler(state: MockState) {
    return async (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = req.url ?? "";
        const method = req.method ?? "GET";

        // Ollama: POST /api/generate
        if (method === "POST" && url === "/api/generate") {
            const body = JSON.parse(await readBody(req));
            const decision = state.aiDecision(body.prompt);
            return jsonResponse(res, {
                model: body.model,
                created_at: new Date().toISOString(),
                response: decision,
                done: true,
                done_reason: "stop",
                context: [],
                total_duration: 1000000,
                load_duration: 1000000,
                prompt_eval_count: 10,
                eval_count: 1,
            });
        }

        // OpenAI Responses API: POST /responses
        // (SDK appends path to OPENAI_BASE_URL, so if base=http://host:port, path is /responses)
        if (method === "POST" && url === "/responses") {
            const body = JSON.parse(await readBody(req));
            const input = typeof body.input === "string" ? body.input : "";
            const decision = state.aiDecision(input);
            return jsonResponse(res, {
                id: "resp_test",
                object: "response",
                created_at: Date.now(),
                status: "completed",
                model: body.model ?? "gpt-4o-mini",
                output: [
                    {
                        type: "message",
                        id: "msg_test",
                        status: "completed",
                        role: "assistant",
                        content: [
                            { type: "output_text", text: decision, annotations: [] },
                        ],
                    },
                ],
                usage: {
                    input_tokens: 10,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: 1,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: 11,
                },
            });
        }

        jsonResponse(res, { error: "not found" }, 404);
    };
}

function listenAsync(server: http.Server): Promise<number> {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve((server.address() as { port: number }).port);
        });
    });
}

function closeAsync(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
    );
}

// ---------------------------------------------------------------------------
// Test scaffolding helpers
// ---------------------------------------------------------------------------

async function withTmpDir<T>(
    promptFiles: Record<string, string>,
    fn: (dir: string) => Promise<T>,
): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "miniflux-ai-test-"));
    for (const [name, content] of Object.entries(promptFiles)) {
        await writeFile(join(dir, name), content);
    }
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true });
    }
}

async function withServers<T>(
    state: MockState,
    fn: (minifluxUrl: string, aiUrl: string) => Promise<T>,
): Promise<T> {
    const minifluxServer = http.createServer(createMinifluxHandler(state));
    const aiServer = http.createServer(createAiHandler(state));
    const [mPort, aPort] = await Promise.all([
        listenAsync(minifluxServer),
        listenAsync(aiServer),
    ]);
    try {
        return await fn(`http://127.0.0.1:${mPort}`, `http://127.0.0.1:${aPort}`);
    } finally {
        await Promise.all([closeAsync(minifluxServer), closeAsync(aiServer)]);
    }
}

function buildEnv(opts: {
    minifluxUrl: string;
    aiUrl: string;
    aiProvider?: string;
    batchSize?: number;
}): Record<string, string> {
    return {
        PATH: process.env.PATH ?? "",
        MINIFLUX_URL: opts.minifluxUrl,
        MINIFLUX_AUTH_TOKEN: "test-token",
        OLLAMA_BASE_URL: opts.aiUrl,
        OPENAI_BASE_URL: opts.aiUrl,
        OPENAI_API_KEY: "test-key",
        PROCESSING_BATCH_SIZE: String(opts.batchSize ?? 10),
        OLLAMA_MODEL: "llama3",
        ...(opts.aiProvider ? { AI_PROVIDER: opts.aiProvider } : {}),
    };
}

function runCli(
    cwd: string,
    env: Record<string, string>,
    args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd });
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        proc.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
        proc.on("error", reject);
    });
}

function spawnCli(
    cwd: string,
    env: Record<string, string>,
    args: string[] = [],
): ChildProcess {
    return spawn(process.execPath, [CLI_PATH, ...args], { env, cwd });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("miniflux-ai CLI", () => {
    it("Ollama — marks irrelevant entries as read in Miniflux", async () => {
        const state = createState(
            [
                makeEntry("1", "TypeScript 6 released", "Great new features", "cat-1", "Tech"),
                makeEntry("2", "Buy cheap shoes now!", "Ad content", "cat-1", "Tech"),
            ],
            (prompt) => (prompt.includes("TypeScript") ? "yes" : "no"),
        );

        await withTmpDir({ "custom-prompt-tech.md": TECH_PROMPT }, async (tmpDir) => {
            await withServers(state, async (minifluxUrl, aiUrl) => {
                const { exitCode } = await runCli(tmpDir, buildEnv({ minifluxUrl, aiUrl }));
                assert.equal(exitCode, 0);
                assert.deepEqual(state.markedAsRead, ["2"]);
            });
        });
    });

    it("OpenAI — marks irrelevant entries as read in Miniflux", async () => {
        const state = createState(
            [
                makeEntry("1", "TypeScript 6 released", "Great new features", "cat-1", "Tech"),
                makeEntry("2", "Buy cheap shoes now!", "Ad content", "cat-1", "Tech"),
            ],
            (input) => (input.includes("TypeScript") ? "yes" : "no"),
        );

        await withTmpDir({ "custom-prompt-tech.md": TECH_PROMPT }, async (tmpDir) => {
            await withServers(state, async (minifluxUrl, aiUrl) => {
                const { exitCode } = await runCli(
                    tmpDir,
                    buildEnv({ minifluxUrl, aiUrl, aiProvider: "OPENAI" }),
                );
                assert.equal(exitCode, 0);
                assert.deepEqual(state.markedAsRead, ["2"]);
            });
        });
    });

    it("processes all entries across multiple batches before exiting", async () => {
        const state = createState(
            [
                makeEntry("1", "Entry 1", "content", "cat-1", "Tech"),
                makeEntry("2", "Entry 2", "content", "cat-1", "Tech"),
                makeEntry("3", "Entry 3", "content", "cat-1", "Tech"),
            ],
            () => "no",
        );

        await withTmpDir({ "custom-prompt-tech.md": TECH_PROMPT }, async (tmpDir) => {
            await withServers(state, async (minifluxUrl, aiUrl) => {
                const { exitCode } = await runCli(
                    tmpDir,
                    buildEnv({ minifluxUrl, aiUrl, batchSize: 2 }),
                );
                assert.equal(exitCode, 0);
                assert.equal(state.markedAsRead.length, 3);
            });
        });
    });

    it("no match — exits cleanly when no category matches a prompt file", async () => {
        const state = createState(
            [makeEntry("1", "Goal!", "Soccer match recap", "cat-1", "Sports")],
            () => "no",
        );

        await withTmpDir({ "custom-prompt-tech.md": TECH_PROMPT }, async (tmpDir) => {
            await withServers(state, async (minifluxUrl, aiUrl) => {
                const { exitCode } = await runCli(tmpDir, buildEnv({ minifluxUrl, aiUrl }));
                assert.equal(exitCode, 0);
                assert.deepEqual(state.markedAsRead, []);
            });
        });
    });

    it("multi-category — applies per-category AI decisions independently", async () => {
        // Tech entries are relevant (yes), Finance entries are irrelevant (no).
        // Only the Finance entry should be marked as read in Miniflux.
        const state = createState(
            [
                makeEntry("t1", "Tech item", "content", "cat-1", "Tech"),
                makeEntry("f1", "Finance item", "content", "cat-2", "Finance"),
            ],
            (prompt) => (prompt.includes("Finance item") ? "no" : "yes"),
        );

        await withTmpDir(
            {
                "custom-prompt-tech.md": TECH_PROMPT,
                "custom-prompt-finance.md": "Reply 'yes' if finance news, otherwise 'no'.",
            },
            async (tmpDir) => {
                await withServers(state, async (minifluxUrl, aiUrl) => {
                    const { exitCode } = await runCli(tmpDir, buildEnv({ minifluxUrl, aiUrl }));
                    assert.equal(exitCode, 0);
                    assert.deepEqual(state.markedAsRead, ["f1"]);
                });
            },
        );
    });

    it("watch mode — process stays alive after processing all entries", async () => {
        let resolvePutComplete!: () => void;
        const putComplete = new Promise<void>((r) => (resolvePutComplete = r));

        const state = createState(
            [
                makeEntry("1", "TypeScript 6 released", "content", "cat-1", "Tech"),
                makeEntry("2", "Buy cheap shoes now!", "Ad content", "cat-1", "Tech"),
            ],
            (prompt) => (prompt.includes("TypeScript") ? "yes" : "no"),
        );
        state.onPut = resolvePutComplete;

        await withTmpDir({ "custom-prompt-tech.md": TECH_PROMPT }, async (tmpDir) => {
            await withServers(state, async (minifluxUrl, aiUrl) => {
                const proc = spawnCli(
                    tmpDir,
                    buildEnv({ minifluxUrl, aiUrl }),
                    ["--watch", "--interval=1"],
                );

                try {
                    await Promise.race([
                        putComplete,
                        new Promise<never>((_, reject) =>
                            setTimeout(
                                () => reject(new Error("timeout waiting for first cycle")),
                                5000,
                            ),
                        ),
                    ]);

                    assert.equal(proc.exitCode, null, "watch mode should not exit");
                    assert.deepEqual(state.markedAsRead, ["2"]);
                } finally {
                    proc.kill("SIGTERM");
                    await new Promise<void>((r) => proc.on("close", r));
                }
            });
        });
    });
});
