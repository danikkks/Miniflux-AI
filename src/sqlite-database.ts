import { DatabaseSync } from "node:sqlite";
import type { IDatabase } from "./core.js";

export const makeSqliteDatabase = (path: string): IDatabase => {
    const db = new DatabaseSync(path);
    db.exec(`
        create table if not exists skipped_entries (
            entry_id integer primary key,
            title text not null,
            url text not null,
            content text not null,
            feed_id integer not null,
            category text not null,
            skipped_at text not null default current_timestamp
        )
    `);
    const insert = db.prepare(`
        insert or ignore into skipped_entries (entry_id, title, url, content, feed_id, category)
        values (?, ?, ?, ?, ?, ?)
    `);

    return {
        saveSkippedEntries: async (entries) => {
            for (const e of entries) {
                insert.run(e.id, e.title, e.url, e.content, e.feed.id, e.feed.category.title);
            }
        },
    };
};
