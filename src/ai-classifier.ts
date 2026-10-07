import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import type { IAIClassifier, IEntry } from "./core.js";

const DECISION_CAPABILITY = "decision";
const DECISION_QUESTION_KEY = "relevant";
// /v1/systemone rejects requests over this many tokens and never truncates input itself.
// chars-per-token varies by script/content, so we can't size the truncation up front; instead
// we retry using the actual token count the server reports on overflow.
const SYSTEMONE_TOKEN_LIMIT = 8194;
const SYSTEMONE_TOKEN_TARGET = SYSTEMONE_TOKEN_LIMIT * 0.9;
const SYSTEMONE_MAX_ATTEMPTS = 3;

const overflowTokenCount = (err: unknown): number | null => {
    const message = err instanceof Error ? err.message : "";
    const match = /has (\d+) tokens/.exec(message);
    return match ? Number(match[1]) : null;
};

// capability string returned by `ollama show`, not the model name or api path
export const supportsDecisionApi = async (client: Ollama, model: string): Promise<boolean> => {
    const info = await client.show({ model });
    return info.capabilities.includes(DECISION_CAPABILITY);
};

const classifyWithDecisionApi = async (client: Ollama, model: string, entry: IEntry, prompt: string): Promise<string> => {
    const title = stripHtml(entry.title).result;
    const body = entry.content.length > 1000 ? stripHtml(entry.content).result : "";
    let state = `${title}\n${body}`;

    for (let attempt = 1; attempt <= SYSTEMONE_MAX_ATTEMPTS; attempt++) {
        try {
            const r = await client.systemone({
                model,
                state,
                questions: {
                    [DECISION_QUESTION_KEY]: { type: "noul", instructions: prompt },
                },
            });
            const answer = r.answers[DECISION_QUESTION_KEY];
            return answer.type === "noul" && answer.noul >= 0.5 ? "yes" : "no";
        } catch (err) {
            const actualTokens = overflowTokenCount(err);
            if (actualTokens === null || attempt === SYSTEMONE_MAX_ATTEMPTS) throw err;
            // recalibrate the truncation from the server's own token count instead of guessing chars-per-token
            state = state.slice(0, Math.floor(state.length * (SYSTEMONE_TOKEN_TARGET / actualTokens)));
        }
    }
    throw new Error("unreachable");
};

export const makeAIClassifier = (): IAIClassifier => {
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
    const model = process.env.OLLAMA_MODEL;
    const useDecisionApi = process.env.OLLAMA_DECISION_API === "true";
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
                prompt: `${prompt}\n\n ${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? stripHtml(entry.content).result : ""}`,
                think: true,
            });
            return r.response;
        },
    };
};
