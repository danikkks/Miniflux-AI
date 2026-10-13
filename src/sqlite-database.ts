import { DatabaseSync } from "node:sqlite";
import type { IDatabase, IGroup, IGroupStore, IStoredDecision, Verdict } from "./core.js";

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
    const parentOf = "case when instr(category, ' / ') > 0 then substr(category, 1, instr(category, ' / ') - 1) else category end";
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

        listRecentVerdicts: async (parentCategory, limit) =>
            (db
                .prepare(`select ${selectColumns} from decisions where ${parentOf} = ? and verdict is not null order by verdict_at desc, entry_id desc limit ?`)
                .all(parentCategory, limit) as Row[]).map(toStoredDecision),

        markReviewed: async (entryIds) => {
            const placeholders = entryIds.map(() => "?").join(",");
            db.prepare(`update decisions set reviewed = 1 where entry_id in (${placeholders})`).run(...entryIds);
        },

        discardUnreviewedExceptNewest: async (keep) => {
            db.prepare(`
                update decisions set reviewed = 1
                where reviewed = 0 and verdict is null and entry_id not in (
                    select entry_id from decisions where reviewed = 0
                    order by decided_at desc, entry_id desc limit ?
                )
            `).run(keep);
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

type GroupRow = {
    group_id: number;
    entry_id: number;
    title: string;
    url: string;
    content: string;
    added_at: string;
    group_title: string | null;
    group_description: string | null;
    summarized_count: number;
};

export const makeSqliteGroupStore = (path: string): IGroupStore => {
    const db = new DatabaseSync(path);
    db.exec(`
        create table if not exists groups (
            id integer primary key autoincrement,
            created_at text not null default current_timestamp,
            title text,
            description text,
            summarized_count integer not null default 0
        );
        create table if not exists group_entries (
            entry_id integer primary key,
            group_id integer not null references groups (id),
            title text not null,
            url text not null,
            content text not null,
            added_at text not null default current_timestamp
        )
    `);
    const groupColumns = db.prepare("pragma table_info(groups)").all();
    if (!groupColumns.some((c) => c.name === "title")) {
        db.exec("alter table groups add column title text");
        db.exec("alter table groups add column description text");
        db.exec("alter table groups add column summarized_count integer not null default 0");
    }
    const newGroup = db.prepare("insert into groups default values");
    const addEntry = db.prepare("insert or ignore into group_entries (entry_id, group_id, title, url, content) values (?, ?, ?, ?, ?)");

    return {
        listGroupsSince: async (hours) => {
            const rows = db.prepare(`
                select e.group_id, e.entry_id, e.title, e.url, e.content, e.added_at,
                    g.title as group_title, g.description as group_description, g.summarized_count
                from group_entries e join groups g on g.id = e.group_id
                where e.group_id in (
                    select group_id from group_entries group by group_id
                    having max(added_at) >= datetime('now', ?)
                )
                order by e.added_at, e.entry_id
            `).all(`-${hours} hours`) as GroupRow[];

            const byId = new Map<number, IGroup>();
            for (const r of rows) {
                const group = byId.get(r.group_id) ?? {
                    id: String(r.group_id),
                    entries: [],
                    updatedAt: r.added_at,
                    summary: r.group_title === null ? null : { title: r.group_title, description: r.group_description ?? "" },
                    summarizedCount: r.summarized_count,
                };
                group.entries.push({ entryId: String(r.entry_id), title: r.title, url: r.url, content: r.content });
                group.updatedAt = r.added_at;
                byId.set(r.group_id, group);
            }
            return [...byId.values()].sort(
                (a, b) => b.updatedAt.localeCompare(a.updatedAt) || Number(b.id) - Number(a.id),
            );
        },

        groupedEntryIds: async (entryIds) => {
            const placeholders = entryIds.map(() => "?").join(",");
            return (db
                .prepare(`select entry_id from group_entries where entry_id in (${placeholders})`)
                .all(...entryIds) as { entry_id: number }[]).map((r) => String(r.entry_id));
        },

        addToGroup: async (groupId, entry) => {
            const existing = db.prepare("select group_id from group_entries where entry_id = ?").get(entry.id) as { group_id: number } | undefined;
            if (existing) return String(existing.group_id);
            const id = groupId ?? String(newGroup.run().lastInsertRowid);
            addEntry.run(entry.id, id, entry.title, entry.url, entry.content);
            return id;
        },

        saveSummary: async (groupId, summary, entryCount) => {
            db.prepare("update groups set title = ?, description = ?, summarized_count = ? where id = ?")
                .run(summary.title, summary.description, entryCount, groupId);
        },
    };
};
