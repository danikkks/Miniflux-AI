import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import TurndownService from "turndown";
import type { IAIClassifier, IEntry } from "./core/entities.js";

const DECISION_CAPABILITY = "decision";
const DECISION_QUESTION_KEY = "relevant";
const SYSTEMONE_TOKEN_LIMIT = 8194;
const SYSTEMONE_TOKEN_TARGET = SYSTEMONE_TOKEN_LIMIT * 0.9;
const SYSTEMONE_MAX_ATTEMPTS = 3;
const SYSTEMONE_BODY_LIMIT_BYTES = 64 * 1024 * 0.9;

const structurePreservingHtmlToText = new TurndownService({ headingStyle: "atx" }).addRule("linkText", {
    filter: "a",
    replacement: (content) => content,
});

const systemoneRequest = (model: string, state: string, prompt: string) => ({
    model,
    state,
    questions: {
        [DECISION_QUESTION_KEY]: { type: "noul" as const, instructions: prompt },
    },
});

const fitToBodyLimit = (model: string, state: string, prompt: string): string => {
    const size = Buffer.byteLength(JSON.stringify(systemoneRequest(model, state, prompt)));
    const excess = size - SYSTEMONE_BODY_LIMIT_BYTES;
    return excess > 0 ? state.slice(0, Math.max(0, state.length - Math.ceil(excess))) : state;
};

const overflowTokenCount = (err: unknown): number | null => {
    const message = err instanceof Error ? err.message : "";
    const match = /has (\d+) tokens/.exec(message);
    return match ? Number(match[1]) : null;
};

export const supportsDecisionApi = async (client: Ollama, model: string): Promise<boolean> => {
    const info = await client.show({ model });
    return info.capabilities.includes(DECISION_CAPABILITY);
};

const parseYesNo = (answer: string): boolean => {
    const normalized = answer.toLowerCase().trim();
    if (normalized === "yes") return true;
    if (normalized === "no") return false;
    throw new Error(`expected "yes" or "no", got "${answer}"`);
};

const classifyWithDecisionApi = async (client: Ollama, model: string, entry: IEntry, prompt: string): Promise<boolean> => {
    const title = stripHtml(entry.title).result;
    const body = entry.content.length > 1000 ? structurePreservingHtmlToText.turndown(entry.content) : "";
    let state = fitToBodyLimit(model, `${title}\n${body}`, prompt);

    for (let attempt = 1; attempt <= SYSTEMONE_MAX_ATTEMPTS; attempt++) {
        try {
            const r = await client.systemone(systemoneRequest(model, state, prompt));
            const answer = r.answers[DECISION_QUESTION_KEY];
            return answer.type === "noul" && answer.noul >= 0.5;
        } catch (err) {
            const actualTokens = overflowTokenCount(err);
            if (actualTokens === null || attempt === SYSTEMONE_MAX_ATTEMPTS) throw err;
            state = state.slice(0, Math.floor(state.length * (SYSTEMONE_TOKEN_TARGET / actualTokens)));
        }
    }
    throw new Error("unreachable");
};

export interface IAIClassifierConfig {
    useOpenAI: boolean;
    openaiApiKey: string;
    ollamaBaseUrl: string | undefined;
    ollamaModel: string | undefined;
    useDecisionApi: boolean;
}

export const makeAIClassifier = (config: IAIClassifierConfig): IAIClassifier => {
    if (config.useOpenAI) {
        const client = new OpenAI({ apiKey: config.openaiApiKey });
        return {
            classify: async (entry, prompt) => {
                const r = await client.responses.create({
                    model: "gpt-5-nano",
                    instructions: prompt,
                    input: `# ${entry.title}\n${entry.content}`,
                });
                return parseYesNo(r.output_text);
            },
        };
    }

    const client = new Ollama({ host: config.ollamaBaseUrl });
    const model = config.ollamaModel;
    if (!model) throw new Error("OLLAMA_MODEL is required");
    const { useDecisionApi } = config;
    let decisionApiChecked = false;

    return {
        classify: async (entry, prompt) => {
            if (useDecisionApi) {
                if (!decisionApiChecked) {
                    if (!(await supportsDecisionApi(client, model))) {
                        throw new Error(`model "${model}" does not support the decision api`);
                    }
                    decisionApiChecked = true;
                }
                return classifyWithDecisionApi(client, model, entry, prompt);
            }

            const r = await client.generate({
                model,
                prompt: `${prompt}\n\n ${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? structurePreservingHtmlToText.turndown(entry.content) : ""}`,
                think: true,
            });
            if (r.response === undefined) throw new Error("model returned no response");
            return parseYesNo(r.response);
        },
    };
};
