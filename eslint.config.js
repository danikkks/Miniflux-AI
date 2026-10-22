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

const noClasses = {
  selector: "ClassDeclaration, ClassExpression",
  message: "do not define classes. use a factory function that returns an object and keeps state in a closure",
};

export default tseslint.config(
  { ignores: ["*.js", "dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  { languageOptions: { parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname } } },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { local: { rules: { "no-comments": noComments } } },
    rules: {
      "no-restricted-syntax": ["error", noClasses],
      "local/no-comments": "error",
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test"] }] }],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/bootstrap.ts"],
    rules: {
      "no-restricted-syntax": ["error", noClasses, {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: "only src/bootstrap.ts may read environment variables. pass values in as arguments",
      }],
    },
  },
  {
    files: ["test/**/*.ts"],
    ignores: ["test/mockserver.ts"],
    rules: {
      "no-restricted-syntax": ["error", noClasses, {
        selector: "CallExpression[callee.name='setTimeout']",
        message: "use eventually() to wait for a condition, or wait for the run to finish (GET /process) to prove nothing happens",
      }],
    },
  },
  {
    files: ["src/sqlite-database.ts"],
    rules: { "@typescript-eslint/require-await": "off" },
  },
);
