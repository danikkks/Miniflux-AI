import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import TurndownService from "turndown";
import type { IAIClassifier, ICriteria, IEntry, IReference } from "./core/entities.js";

const DECISION_CAPABILITY = "decision";
const DECISION_QUESTION_KEY = "relevant";
const SYSTEMONE_TOKEN_LIMIT = 8194;
const SYSTEMONE_TOKEN_TARGET = SYSTEMONE_TOKEN_LIMIT * 0.9;
const SYSTEMONE_MAX_ATTEMPTS = 3;
const SYSTEMONE_BODY_LIMIT_BYTES = 64 * 1024 * 0.9;
const REFERENCE_EXCERPT_LENGTH = 500;

const structurePreservingHtmlToText = new TurndownService({ headingStyle: "atx" }).addRule("linkText", {
    filter: "a",
    replacement: (content) => content,
});

const systemoneRequest = (model: string, state: string, prompt: string, criteria?: ICriteria) => ({
    model,
    state,
    questions: {
        [DECISION_QUESTION_KEY]: { type: "noul" as const, instructions: prompt, ...(criteria && { criteria }) },
    },
});

const fitToBodyLimit = (model: string, state: string, prompt: string, criteria?: ICriteria): string => {
    const size = Buffer.byteLength(JSON.stringify(systemoneRequest(model, state, prompt, criteria)));
    const excess = size - SYSTEMONE_BODY_LIMIT_BYTES;
    return excess > 0 ? state.slice(0, Math.max(0, state.length - Math.ceil(excess))) : state;
};

const overflowTokenCount = (err: unknown): number | null => {
    const message = err instanceof Error ? err.message : "";
    const match = /has (\d+) tokens/.exec(message);
    return match ? Number(match[1]) : null;
};

const stateOf = (entry: IEntry, reference?: IReference): string => {
    const article = `${stripHtml(entry.title).result}\n${structurePreservingHtmlToText.turndown(entry.content)}`;
    if (!reference) return article;
    const excerpt = structurePreservingHtmlToText.turndown(reference.content).slice(0, REFERENCE_EXCERPT_LENGTH);
    return `Reference story:\n${stripHtml(reference.title).result}\n${excerpt}\n\nArticle:\n${article}`;
};

const supportsDecisionApi = async (client: Ollama, model: string): Promise<boolean> => {
    const info = await client.show({ model });
    return info.capabilities.includes(DECISION_CAPABILITY);
};

const classifyWithDecisionApi = async (
    client: Ollama, model: string, entry: IEntry, prompt: string, criteria?: ICriteria, reference?: IReference,
): Promise<number> => {
    let state = fitToBodyLimit(model, stateOf(entry, reference), prompt, criteria);

    for (let attempt = 1; attempt <= SYSTEMONE_MAX_ATTEMPTS; attempt++) {
        try {
            const r = await client.systemone(systemoneRequest(model, state, prompt, criteria));
            const answer = r.answers[DECISION_QUESTION_KEY];
            if (answer.type !== "noul") throw new Error(`unexpected answer type "${answer.type}"`);
            return answer.noul;
        } catch (err) {
            const actualTokens = overflowTokenCount(err);
            if (actualTokens === null || attempt === SYSTEMONE_MAX_ATTEMPTS) throw err;
            state = state.slice(0, Math.floor(state.length * (SYSTEMONE_TOKEN_TARGET / actualTokens)));
        }
    }
    throw new Error("unreachable");
};

export const makeAIClassifier = (ollamaBaseUrl: string | undefined, model: string): IAIClassifier => {
    const client = new Ollama({ host: ollamaBaseUrl });
    let decisionApiChecked = false;

    return {
        classify: async (entry, prompt, criteria, reference) => {
            if (!decisionApiChecked) {
                if (!(await supportsDecisionApi(client, model))) {
                    throw new Error(`model "${model}" does not support the decision api`);
                }
                decisionApiChecked = true;
            }
            return classifyWithDecisionApi(client, model, entry, prompt, criteria, reference);
        },
    };
};
