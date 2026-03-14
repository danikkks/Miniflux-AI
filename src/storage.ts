import { DatabaseSync } from "node:sqlite";
import { resolve } from "path";

export function createStorage(dir: string) {
    const path = dir === ":memory:" ? ":memory:" : resolve(dir, "miniflux-ai.db");
    const db = new DatabaseSync(path);

    db.exec(`
        create table if not exists kv_store (
            key text primary key,
            value text not null,
            created_at integer not null default (unixepoch())
        )
    `);

    const stmtInsert = db.prepare(
        "insert or ignore into kv_store (key, value) values (?, ?)",
    );

    return {
        has(key: string): boolean {
            return !!db
                .prepare("select 1 from kv_store where key = ?")
                .get(key);
        },

        filterNewKeys(keys: string[]): string[] {
            if (keys.length === 0) return [];
            const placeholders = keys.map(() => "?").join(",");
            const existing = new Set(
                (
                    db
                        .prepare(
                            `select key from kv_store where key in (${placeholders})`,
                        )
                        .all(...keys) as { key: string }[]
                ).map((r) => r.key),
            );
            return keys.filter((k) => !existing.has(k));
        },

        set(key: string, value: string): void {
            stmtInsert.run(key, value);
        },

        setMany(entries: { key: string; value: string }[]): void {
            if (entries.length === 0) return;
            db.exec("begin");
            try {
                for (const e of entries) stmtInsert.run(e.key, e.value);
                db.exec("commit");
            } catch (e) {
                db.exec("rollback");
                throw e;
            }
        },
    };
}
