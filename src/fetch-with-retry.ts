import type { ILogger } from "./core/entities.js";

const RETRY_DELAYS_MS = [1000, 2000, 4000];

const RETRIED_STATUSES = [502, 503, 504];

const isNetworkError = (err: unknown) => err instanceof TypeError && err.message === "fetch failed";

const describe = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    `${init?.method ?? "GET"} ${input instanceof Request ? input.url : String(input)}`;

export const makeFetchWithRetry = (log: ILogger): typeof fetch => async (input, init) => {
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
        let reason: unknown;
        try {
            const r = await fetch(input, init);
            if (!RETRIED_STATUSES.includes(r.status)) return r;
            await r.body?.cancel();
            reason = `status ${r.status}`;
        } catch (err) {
            if (!isNetworkError(err)) throw err;
            reason = err;
        }
        log.info("%s failed, retry %d/%d in %dms", describe(input, init), i + 1, RETRY_DELAYS_MS.length, delay, reason);
        await new Promise((r) => setTimeout(r, delay));
    }
    return fetch(input, init);
};
