import type { RunEvent } from "./core/entities.js";

type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;

type Checked<M extends Record<RunEvent["type"], string>> = {
    [T in keyof M]: Placeholders<M[T]> extends keyof Extract<RunEvent, { type: T }> ? M[T] : "unknown placeholder";
};

const ENTRY = '[{index}/{total}] entry {entryId} "{title}"';

const ENGLISH = {
    "run-started": "run started",
    "run-failed": "run failed",
    "filter-scope": "{prompts} prompts, {categories} categories, {feeds} feeds",
    "to-classify": "{count} to classify",
    "entry-relevant": `${ENTRY} -> relevant`,
    "entry-irrelevant": `${ENTRY} -> irrelevant`,
    "entry-unsure": `${ENTRY} -> unsure, left unread`,
    "entry-failed": `${ENTRY} failed, retrying next run`,
    "filter-finished": "run finished in {seconds}s: {relevant} relevant, {irrelevant} irrelevant marked as read, {failed} failed",
    "group-scope": "{categories} categories, {feeds} feeds, {openGroups} open groups",
    "stale-marked-read": "{count} already grouped entries marked as read again",
    "stale-mark-failed": "marking already grouped entries as read failed",
    "fetch-failed": "fetching unread entries failed, grouping stopped",
    "to-group": "{count} to group",
    "entry-digest": `${ENTRY} -> digest, skipped`,
    "entry-not-news": `${ENTRY} -> not a news event, marked as read`,
    "entry-grouped": `${ENTRY} -> group {groupId} "{groupTitle}"`,
    "group-started": `${ENTRY} -> new group {groupId}`,
    "summarizing": "summarizing {count} changed groups",
    "group-summarized": '[{index}/{total}] group {groupId} summarized: "{summaryTitle}"',
    "summary-failed": "[{index}/{total}] group {groupId} summary failed",
    "feed-published": "feed published with {groups} groups",
    "feeds-refreshed": "{count} miniflux feeds refreshed",
    "feed-unchanged": "feed unchanged, upload skipped",
    "group-finished": "run finished in {seconds}s: {grouped} grouped, {failed} failed",
} as const;

export const ENGLISH_TEMPLATES: Checked<typeof ENGLISH> = ENGLISH;
