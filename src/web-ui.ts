import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IReviewItem, IReviewPrompt, IReviewService } from "./core.js";

const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const COPY_SCRIPT =
    "const t=this.closest('section').querySelector('textarea');t.select();" +
    "(navigator.clipboard?.writeText(t.value)??Promise.reject()).catch(()=>document.execCommand('copy'))";

const itemRow = (i: IReviewItem): string => `
    <li>
        <input type="hidden" name="reviewed" value="${esc(i.entryId)}">
        <label>
            <input type="checkbox" name="wrong" value="${esc(i.entryId)}"${i.verdict === "wrong" ? " checked" : ""}>
            wrong
        </label>
        <span class="badge ${esc(i.decision)}">${esc(i.decision)}</span>
        <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
        <small>${esc(i.category)}</small>
        <details><summary>excerpt</summary>${esc(i.excerpt)}</details>
    </li>`;

const pendingStep = (items: IReviewItem[]): string =>
    items.length === 0
        ? `<p>nothing to review</p>`
        : `<h2>1. mark the wrong decisions (${items.length} unreviewed)</h2>
    <form hx-post="/review" hx-target="#step">
        <ul>${items.map(itemRow).join("")}</ul>
        <button type="submit">review done</button>
    </form>`;

const promptCard = (p: IReviewPrompt): string => `
    <section>
        <h3>${esc(p.category)}</h3>
        <form hx-post="/reviewed" hx-target="find .status" hx-swap="innerHTML">
            ${p.entryIds.map((id) => `<input type="hidden" name="reviewed" value="${esc(id)}">`).join("")}
            <button type="submit" onclick="${esc(COPY_SCRIPT)}">copy prompt</button>
            <span class="status"></span>
        </form>
        <textarea readonly rows="20">${esc(p.text)}</textarea>
    </section>`;

const promptsStep = (prompts: IReviewPrompt[]): string => `
    <h2>2. copy the prompt (marks these decisions as reviewed) and ask a stronger model to improve it</h2>
    ${prompts.length === 0 ? "<p>no custom prompt matches the reviewed categories</p>" : prompts.map(promptCard).join("")}
    <button hx-get="/pending" hx-target="#step">review more</button>`;

const page = (step: string): string => `<!doctype html>
<html>
<head>
    <meta charset="utf-8">
    <title>Miniflux-AI review</title>
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <style>
        body { font-family: sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
        li { margin-bottom: 0.75rem; list-style: none; }
        .badge { padding: 0 0.4rem; border-radius: 0.3rem; color: white; }
        .badge.yes { background: seagreen; }
        .badge.no { background: firebrick; }
        textarea { width: 100%; font-family: monospace; }
    </style>
</head>
<body>
    <h1>Decision review</h1>
    <div id="step">${step}</div>
</body>
</html>`;

const readBody = async (req: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString());
};

const send = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
};

export const startWebUi = (service: IReviewService, port: number) => {
    const server = createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url === "/") {
                return send(res, 200, page(pendingStep(await service.listPending())));
            }
            if (req.method === "GET" && req.url === "/pending") {
                return send(res, 200, pendingStep(await service.listPending()));
            }
            if (req.method === "POST" && req.url === "/review") {
                const body = await readBody(req);
                const prompts = await service.submitReview(body.getAll("reviewed"), body.getAll("wrong"));
                return send(res, 200, promptsStep(prompts));
            }
            if (req.method === "POST" && req.url === "/reviewed") {
                const body = await readBody(req);
                await service.markReviewed(body.getAll("reviewed"));
                return send(res, 200, "marked as reviewed");
            }
            send(res, 404, "not found");
        } catch (err) {
            console.error(err);
            send(res, 500, "internal error");
        }
    });
    server.on("error", console.error);
    server.listen(port);
};
