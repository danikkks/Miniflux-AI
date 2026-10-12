import { Ollama } from "ollama/dist/index.cjs";
import { stripHtml } from "string-strip-html";
import type { IGroup, IGroupSummarizer } from "./core.js";

const MAX_ARTICLES = 10;
const EXCERPT_LENGTH = 500;

const buildPrompt = (group: IGroup): string => {
    const articles = group.entries
        .slice(0, MAX_ARTICLES)
        .map((e) => `- ${stripHtml(e.title).result}\n  ${stripHtml(e.content).result.slice(0, EXCERPT_LENGTH)}`)
        .join("\n");
    return `The articles below are about the same news story. Write a neutral headline and a short description (2-3 sentences) of the story. Use the language of the articles. Answer with json: {"title": "...", "description": "..."}.\n\n${articles}`;
};

export const makeAISummarizer = (host: string, model: string): IGroupSummarizer => {
    const client = new Ollama({ host });
    return {
        summarize: async (group) => {
            const r = await client.generate({
                model,
                prompt: buildPrompt(group),
                format: {
                    type: "object",
                    properties: { title: { type: "string" }, description: { type: "string" } },
                    required: ["title", "description"],
                },
                think: false,
            });
            const { title, description } = JSON.parse(r.response);
            // thrown so the group is retried next run instead of stored with an empty title
            if (!title?.trim()) throw new Error("summary has an empty title");
            return { title, description };
        },
    };
};
