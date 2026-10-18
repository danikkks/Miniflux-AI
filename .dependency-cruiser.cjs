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
            name: "entities-import-nothing",
            comment:
                "src/core/entities.ts must not import from src/*. " +
                "It holds the domain types, ports and rules that everything else depends on.",
            severity: "error",
            from: { path: "^src/core/entities\\.ts$" },
            to: { path: "^src/" },
        },
        {
            name: "use-cases-import-only-entities",
            comment:
                "Use cases in src/core/ may import only src/core/entities.ts. " +
                "To fix: move shared rules into entities.ts; reach the outside world through a port " +
                "defined in entities.ts and injected by bootstrap.ts.",
            severity: "error",
            from: { path: "^src/core/", pathNot: "^src/core/entities\\.ts$" },
            to: { path: "^src/", pathNot: "^src/core/entities\\.ts$" },
        },
        {
            name: "adapters-import-only-entities",
            comment:
                "Adapters (src/* outside core/ and bootstrap.ts) may import only src/core/entities.ts. " +
                "To fix: if shared behaviour is needed, define a new port in entities.ts " +
                "and inject the dependency via bootstrap.ts.",
            severity: "error",
            from: { path: "^src/", pathNot: "^src/(core/|bootstrap\\.ts$)" },
            to: { path: "^src/", pathNot: "^src/core/entities\\.ts$" },
        },
        {
            name: "adapters-import-entities-as-types",
            comment: "Adapters must use 'import type { ... }' so only bootstrap.ts wires runtime code together.",
            severity: "error",
            from: { path: "^src/", pathNot: "^src/(core/|bootstrap\\.ts$)" },
            to: { path: "^src/core/", dependencyTypesNot: ["type-only"] },
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
