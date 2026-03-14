import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createStorage } from "./storage.js";

// Pass ":memory:" so tests never touch the filesystem
const storage = () => createStorage(":memory:");

describe("createStorage", () => {
    describe("has", () => {
        it("returns false for a key that does not exist", () => {
            const s = storage();
            assert.equal(s.has("missing"), false);
        });

        it("returns true after the key is stored", () => {
            const s = storage();
            s.set("k", "v");
            assert.equal(s.has("k"), true);
        });
    });

    describe("set", () => {
        it("stores a key-value pair", () => {
            const s = storage();
            s.set("key", "value");
            assert.equal(s.has("key"), true);
        });

        it("is idempotent — duplicate keys are silently ignored", () => {
            const s = storage();
            s.set("key", "first");
            assert.doesNotThrow(() => s.set("key", "second"));
            assert.equal(s.has("key"), true);
        });
    });

    describe("setMany", () => {
        it("stores all provided entries", () => {
            const s = storage();
            s.setMany([
                { key: "a", value: "1" },
                { key: "b", value: "2" },
            ]);
            assert.equal(s.has("a"), true);
            assert.equal(s.has("b"), true);
        });

        it("does nothing when given an empty array", () => {
            const s = storage();
            assert.doesNotThrow(() => s.setMany([]));
        });

        it("is idempotent — duplicate keys within the batch are silently ignored", () => {
            const s = storage();
            s.setMany([{ key: "x", value: "1" }]);
            assert.doesNotThrow(() =>
                s.setMany([{ key: "x", value: "2" }]),
            );
        });
    });

    describe("filterNewKeys", () => {
        it("returns all keys when none are stored", () => {
            const s = storage();
            const result = s.filterNewKeys(["a", "b", "c"]);
            assert.deepEqual(result, ["a", "b", "c"]);
        });

        it("excludes keys that are already stored", () => {
            const s = storage();
            s.set("a", "1");
            const result = s.filterNewKeys(["a", "b", "c"]);
            assert.deepEqual(result, ["b", "c"]);
        });

        it("returns an empty array when all keys are already stored", () => {
            const s = storage();
            s.setMany([
                { key: "a", value: "1" },
                { key: "b", value: "2" },
            ]);
            const result = s.filterNewKeys(["a", "b"]);
            assert.deepEqual(result, []);
        });

        it("returns an empty array when given an empty array", () => {
            const s = storage();
            assert.deepEqual(s.filterNewKeys([]), []);
        });

        it("preserves the original order of new keys", () => {
            const s = storage();
            s.set("b", "1");
            const result = s.filterNewKeys(["c", "a", "b", "d"]);
            assert.deepEqual(result, ["c", "a", "d"]);
        });
    });
});
