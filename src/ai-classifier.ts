import { OpenAI } from "openai";
import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import type { IAIClassifier } from "./core.js";

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
    return {
        classify: async (entry, prompt) => {
            const r = await client.generate({
                model: process.env.OLLAMA_MODEL,
                prompt: `${prompt}\n\n ${stripHtml(entry.title).result}\n${entry.content.length > 1000 ? stripHtml(entry.content).result : ""}`,
                think: true,
            });
            return r.response;
        },
    };
};
