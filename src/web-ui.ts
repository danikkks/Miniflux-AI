import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ILogger, IProcessing, IReviewItem, IReviewPrompt, IReviewService, ProcessingStatus } from "./core/entities.js";

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

type FormVerdicts = Map<string, string>;

const VERDICT_PREFIX = "verdict-";

const verdictsFromForm = (body: URLSearchParams): FormVerdicts =>
    new Map([...body]
        .filter(([name]) => name.startsWith(VERDICT_PREFIX))
        .map(([name, value]) => [name.slice(VERDICT_PREFIX.length), value]));

const verdictRadio = (i: IReviewItem, formVerdicts: FormVerdicts, verdict: string): string => `
        <label>
            <input type="radio" name="${VERDICT_PREFIX}${esc(i.entryId)}" value="${verdict}"${(formVerdicts.get(i.entryId) ?? i.verdict) === verdict ? " checked" : ""}>
            ${verdict}
        </label>`;

const itemRow = (formVerdicts: FormVerdicts) => (i: IReviewItem): string => `
    <li>${verdictRadio(i, formVerdicts, "correct")}${verdictRadio(i, formVerdicts, "wrong")}
        <span class="badge ${esc(i.decision)}">${esc(i.decision)}</span>
        <a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
        <small>${esc(i.category)}</small>
        <details><summary>excerpt</summary>${esc(i.excerpt)}</details>
    </li>`;

const discardForm = (total: number): string => total === 0 ? "" : `
    <form hx-post="/discard" hx-target="#step" hx-include="#review" hx-disabled-elt="find button" hx-confirm="Discard the older unreviewed decisions? They will not be used for prompt improvement.">
        <label>keep newest
            <input type="number" name="keep" min="0" max="${total}" value="${total}" required>
            of ${total} without a verdict
        </label>
        <button type="submit">discard the rest</button>
    </form>`;

const pendingStep = (items: IReviewItem[], formVerdicts: FormVerdicts = new Map()): string =>
    items.length === 0
        ? `<p>nothing to review</p>`
        : `<h2>1. mark the decisions you reviewed as correct or wrong (${items.length} unreviewed)</h2>
    ${discardForm(items.filter((i) => i.verdict === null).length)}
    <form id="review" hx-post="/review" hx-target="#step" hx-disabled-elt="find button">
        <ul>${items.map(itemRow(formVerdicts)).join("")}</ul>
        <button type="submit">review done</button>
    </form>`;

const promptCard = (p: IReviewPrompt): string => `
    <section>
        <h3>${esc(p.category)}</h3>
        <form hx-post="/reviewed" hx-target="find .status" hx-disabled-elt="find button" hx-swap="innerHTML">
            ${p.entryIds.map((id) => `<input type="hidden" name="reviewed" value="${esc(id)}">`).join("")}
            <button type="submit" onclick="${esc(COPY_SCRIPT)}">copy prompt</button>
            <span class="status"></span>
        </form>
        <textarea readonly rows="20">${esc(p.text)}</textarea>
    </section>`;

const promptsStep = (prompts: IReviewPrompt[]): string => `
    <h2>2. copy the prompt (marks these decisions as reviewed) and ask a stronger model to improve it</h2>
    ${prompts.length === 0 ? "<p>no custom prompt matches the reviewed categories</p>" : prompts.map(promptCard).join("")}
    <button hx-get="/pending" hx-target="#step" hx-disabled-elt="this">review more</button>`;

const PROCESS_BUTTON = `<span id="process"><button hx-post="/process" hx-target="#process" hx-swap="outerHTML">process now</button></span>`;

const PROCESSING_BUTTON = `<span id="process" hx-get="/process" hx-trigger="every 3s" hx-swap="outerHTML"><button disabled>processing...</button></span>`;

const toast = (text: string): string =>
    `<div id="toast" hx-swap-oob="true"><div class="toast" role="status">${esc(text)}</div></div>`;

const PROCESS_CONTROLS: Record<ProcessingStatus, string> = {
    idle: PROCESS_BUTTON,
    running: PROCESSING_BUTTON,
    completed: PROCESS_BUTTON + toast("processing completed"),
    failed: PROCESS_BUTTON + toast("processing failed, see logs"),
};

const page = (step: string, processControl: string): string => `<!doctype html>
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
        #error { color: firebrick; }
        header { display: flex; justify-content: space-between; align-items: center; }
        .toast { position: fixed; bottom: 1rem; right: 1rem; padding: 0.75rem 1rem; border-radius: 0.3rem; background: #333; color: white; animation: fade-out 5s forwards; }
        @keyframes fade-out { 80% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
    </style>
    <script>
        const showError = (text) => { document.getElementById("error").textContent = text; };
        document.addEventListener("htmx:beforeRequest", () => showError(""));
        document.addEventListener("htmx:responseError", (e) => showError(e.detail.xhr.responseText || "request failed"));
        document.addEventListener("htmx:sendError", () => showError("server unreachable"));
    </script>
</head>
<body>
    <header>
        <h1>Decision review</h1>
        ${processControl}
    </header>
    <div id="toast"></div>
    <p id="error" role="alert"></p>
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

export const startWebUi = (service: IReviewService, processing: IProcessing, port: number, log: ILogger) => {
    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        try {
            if (req.method === "GET" && req.url === "/") {
                send(res, 200, page(pendingStep(await service.listPending()), processing.status() === "running" ? PROCESSING_BUTTON : PROCESS_BUTTON));
                return;
            }
            if (req.method === "GET" && req.url === "/pending") {
                send(res, 200, pendingStep(await service.listPending()));
                return;
            }
            if (req.method === "POST" && req.url === "/review") {
                const formVerdicts = verdictsFromForm(await readBody(req));
                if (formVerdicts.size === 0) {
                    send(res, 400, "mark at least one decision as correct or wrong");
                    return;
                }
                const prompts = await service.submitReview(
                    [...formVerdicts.keys()],
                    [...formVerdicts].filter(([, verdict]) => verdict === "wrong").map(([id]) => id),
                );
                send(res, 200, promptsStep(prompts));
                return;
            }
            if (req.method === "POST" && req.url === "/discard") {
                const body = await readBody(req);
                const keep = parseInt(body.get("keep") ?? "");
                if (!(keep >= 0)) {
                    send(res, 400, "keep must be a non-negative number");
                    return;
                }
                await service.discardPending(keep);
                send(res, 200, pendingStep(await service.listPending(), verdictsFromForm(body)));
                return;
            }
            if (req.method === "POST" && req.url === "/reviewed") {
                const body = await readBody(req);
                await service.markReviewed(body.getAll("reviewed"));
                send(res, 200, "marked as reviewed");
                return;
            }
            if (req.method === "POST" && req.url === "/process") {
                log.info("processing requested");
                void processing.run();
                send(res, 200, PROCESSING_BUTTON);
                return;
            }
            if (req.method === "GET" && req.url === "/process") {
                send(res, 200, PROCESS_CONTROLS[processing.status()]);
                return;
            }
            send(res, 404, "not found");
        } catch (err) {
            log.error("%s %s failed", req.method, req.url, err);
            send(res, 500, "internal error");
        }
    };
    const server = createServer((req, res) => {
        void handle(req, res);
    });
    server.on("error", (err) => {
        log.error("server error", err);
        process.exit(1);
    });
    server.listen(port);
};
