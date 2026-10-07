import { DatabaseSync } from "node:sqlite";
import type { IDatabase } from "./core.js";

export const makeSqliteDatabase = (path: string): IDatabase => {
    const db = new DatabaseSync(path);
    db.exec(`
        create table if not exists decisions (
            entry_id integer primary key,
            title text not null,
            url text not null,
            content text not null,
            feed_id integer not null,
            category text not null,
            decision text not null,
            decided_at text not null default current_timestamp
        )
    `);
    const insert = db.prepare(`
        insert or replace into decisions (entry_id, title, url, content, feed_id, category, decision)
        values (?, ?, ?, ?, ?, ?, ?)
    `);

    return {
        saveDecisions: async (decisions) => {
            for (const { entry: e, decision } of decisions) {
                insert.run(e.id, e.title, e.url, e.content, e.feed.id, e.feed.category.title, decision);
            }
        },
    };
};
