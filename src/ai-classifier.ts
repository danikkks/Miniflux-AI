import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import type { IAIClassifier, IEntry } from "./core.js";

const DECISION_CAPABILITY = "decision";
const DECISION_QUESTION_KEY = "relevant";

// capability string returned by `ollama show`, not the model name or api path
export const supportsDecisionApi = async (client: Ollama, model: string): Promise<boolean> => {
    const info = await client.show({ model });
    return info.capabilities.includes(DECISION_CAPABILITY);
};

const classifyWithDecisionApi = async (client: Ollama, model: string, entry: IEntry, prompt: string): Promise<string> => {
    const r = await client.systemone({
        model,
        state: `${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? stripHtml(entry.content).result : ""}`,
        questions: {
            [DECISION_QUESTION_KEY]: { type: "noul", instructions: prompt },
        },
    });
    const answer = r.answers[DECISION_QUESTION_KEY];
    return answer.type === "noul" && answer.noul >= 0.5 ? "yes" : "no";
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
