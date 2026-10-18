import { readdir, readFile } from "fs/promises";
import { resolve } from "path";
import type { IPromptLoader } from "./core/entities.js";

export const makePromptLoader = (directory: string): IPromptLoader => ({
    load: async () => {
        const files = await readdir(directory);
        const promptFiles = files.filter(
            (f) => f.startsWith("custom-prompt-") && f.endsWith(".md"),
        );
        const contents = await Promise.all(
            promptFiles.map((f) =>
                readFile(resolve(directory, f), { encoding: "utf8" }),
            ),
        );
        return contents.map((content, i) => ({
            category: promptFiles[i]
                .replace(/^custom-prompt-/, "")
                .replace(/\.md$/, ""),
            content,
        }));
    },
});
