import { readdir, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { type IPromptLoader } from "./core.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const promptLoader: IPromptLoader = {
    load: async () => {
        const files = await readdir(__dirname);
        const promptFiles = files.filter(
            (f) => f.startsWith("custom-prompt-") && f.endsWith(".md"),
        );
        const contents = await Promise.all(
            promptFiles.map((f) =>
                readFile(resolve(__dirname, f), { encoding: "utf8" }),
            ),
        );
        return contents.map((content, i) => ({
            category: promptFiles[i]
                .replace(/^custom-prompt-/, "")
                .replace(/\.md$/, ""),
            content,
        }));
    },
};
