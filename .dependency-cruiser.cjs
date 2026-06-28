/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: "no-test-imports-src",
            comment:
                "test/* must not import from src/*. " +
                "To fix: use the mock server (test/mockserver.ts) to stub external APIs, " +
                "and duplicate any types you need directly in test/fixtures.ts. " +
                "Tests should treat the app as a black box.",
            severity: "error",
            from: { path: "^test/" },
            to: { path: "^src/" },
        },
        {
            name: "no-core-imports-src",
            comment:
                "src/core.ts must not import from src/*. " +
                "To fix: move the dependency into the caller (e.g. bootstrap.ts) and pass it " +
                "into core via dependency injection. core.ts must stay pure - only node_modules allowed.",
            severity: "error",
            from: { path: "^src/core\\.ts$" },
            to: { path: "^src/" },
        },
    ],
    options: {
        tsConfig: {
            fileName: "tsconfig.json",
        },
        enhancedResolveOptions: {
            exportsFields: ["exports"],
            conditionNames: ["import", "require", "node", "default"],
            extensions: [".ts", ".js"],
        },
    },
};
