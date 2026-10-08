import { DatabaseSync } from "node:sqlite";
import type { IDatabase, IStoredDecision, Verdict } from "./core.js";

type Row = {
    entry_id: number;
    title: string;
    url: string;
    content: string;
    category: string;
    decision: string;
    verdict: Verdict | null;
};

const toStoredDecision = (r: Row): IStoredDecision => ({
    entryId: String(r.entry_id),
    title: r.title,
    url: r.url,
    content: r.content,
    category: r.category,
    decision: r.decision,
    verdict: r.verdict,
});

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
            verdict text,
            verdict_at text,
            reviewed integer not null default 0,
            decided_at text not null default current_timestamp
        )
    `);
    const columns = db.prepare("pragma table_info(decisions)").all();
    if (!columns.some((c) => c.name === "verdict")) {
        db.exec("alter table decisions add column verdict text");
    }
    if (!columns.some((c) => c.name === "verdict_at")) {
        db.exec("alter table decisions add column verdict_at text");
        db.exec("update decisions set verdict_at = decided_at where verdict is not null");
    }
    if (!columns.some((c) => c.name === "reviewed")) {
        db.exec("alter table decisions add column reviewed integer not null default 0");
        db.exec("update decisions set reviewed = 1 where verdict is not null");
    }

    const upsert = db.prepare(`
        insert into decisions (entry_id, title, url, content, feed_id, category, decision)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict (entry_id) do update set
            verdict = case when decision = excluded.decision then verdict end,
            reviewed = case when decision = excluded.decision then reviewed else 0 end,
            decision = excluded.decision,
            decided_at = current_timestamp
    `);
    const setVerdict = db.prepare("update decisions set verdict = ?, verdict_at = current_timestamp where entry_id = ?");
    const selectColumns = "entry_id, title, url, content, category, decision, verdict";

    return {
        saveDecisions: async (decisions) => {
            for (const { entry: e, decision } of decisions) {
                upsert.run(e.id, e.title, e.url, e.content, e.feed.id, e.feed.category.title, decision);
            }
        },

        listUnreviewedDecisions: async () =>
            (db
                .prepare(`select ${selectColumns} from decisions where reviewed = 0 order by decided_at desc, entry_id desc`)
                .all() as Row[]).map(toStoredDecision),

        getDecisions: async (entryIds) => {
            const placeholders = entryIds.map(() => "?").join(",");
            return (db
                .prepare(`select ${selectColumns} from decisions where entry_id in (${placeholders})`)
                .all(...entryIds) as Row[]).map(toStoredDecision);
        },

        listRecentVerdicts: async (category, limit) =>
            (db
                .prepare(`select ${selectColumns} from decisions where category = ? and verdict is not null order by verdict_at desc, entry_id desc limit ?`)
                .all(category, limit) as Row[]).map(toStoredDecision),

        markReviewed: async (entryIds) => {
            const placeholders = entryIds.map(() => "?").join(",");
            db.prepare(`update decisions set reviewed = 1 where entry_id in (${placeholders})`).run(...entryIds);
        },

        saveVerdicts: async (verdicts) => {
            db.exec("begin");
            try {
                for (const v of verdicts) setVerdict.run(v.verdict, v.entryId);
                db.exec("commit");
            } catch (err) {
                db.exec("rollback");
                throw err;
            }
        },
    };
};
