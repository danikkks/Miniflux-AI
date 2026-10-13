import js from "@eslint/js";
import tseslint from "typescript-eslint";

const noComments = {
  meta: { type: "problem", messages: { comment: "comments are not allowed except TODO and urls. do not rewrite or move the comment: if it explains a reason, make the code say it by renaming the identifier or extracting a well-named function or constant; if it restates the code, delete it; if it records unfinished work, turn it into a TODO comment" }, schema: [] },
  create: (context) => ({
    Program: () => {
      for (const comment of context.sourceCode.getAllComments()) {
        if (/^\s*TODO\b/.test(comment.value) || /https?:\/\//.test(comment.value)) continue;
        context.report({ loc: comment.loc, messageId: "comment" });
      }
    },
  }),
};

export default tseslint.config(
  { ignores: ["*.js", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { local: { rules: { "no-comments": noComments } } },
    rules: { "local/no-comments": "error" },
  },
);
