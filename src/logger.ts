import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import type { ILogger, IRunLogger, RunEvent, RunEventTemplates, RunLogRecord } from "./core/entities.js";

type Level = "INFO" | "DEBUG" | "ERROR";

const KEPT_RUNS = 10;

const KEPT_RECORDS = 1000;

const INSPECT = { depth: null, maxArrayLength: null, maxStringLength: null, breakLength: 120 };

const describeEvent = (templates: RunEventTemplates, event: RunEvent): string =>
    templates[event.type].replace(/\{(\w+)\}/g, (_, name: string) => String((event as Record<string, unknown>)[name]));

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const fileSafeTimestamp = () => new Date().toISOString().replaceAll(":", "-");

export type Logs = {
    logger(process: string, run?: string): ILogger;
    startRun(run: string): void;
    runLogger(process: string, run?: string): IRunLogger;
    records(run: string): RunLogRecord[];
};

export const makeLogs = (dir: string, debug: boolean, templates: RunEventTemplates): Logs => {
    mkdirSync(dir, { recursive: true });
    const runFiles = new Map<string, string>();
    const runRecords = new Map<string, RunLogRecord[]>();

    const write = (level: Level, process: string, run: string, message: string, details: unknown[]) => {
        const line = `${new Date().toISOString()} ${level.padEnd(5)} [${process}] ${formatWithOptions(INSPECT, message, ...details)}\n`;
        (level === "ERROR" ? globalThis.process.stderr : globalThis.process.stdout).write(line);
        appendFileSync(runFiles.get(run) ?? join(dir, `${run}.log`), line);
    };

    const keep = (run: string, record: RunLogRecord) => {
        const records = runRecords.get(run);
        records?.push(record);
        if (records && records.length > KEPT_RECORDS) records.shift();
    };

    return {
        logger: (process, run = process) => ({
            info: (message, ...details) => {
                write("INFO", process, run, message, details);
            },
            debug: (message, ...details) => {
                if (debug) write("DEBUG", process, run, message, details);
            },
            error: (message, ...details) => {
                write("ERROR", process, run, message, details);
            },
        }),
        runLogger: (process, run = process) => ({
            info: (event) => {
                write("INFO", process, run, describeEvent(templates, event), []);
                keep(run, { ...event, time: new Date().toISOString(), level: "INFO", process });
            },
            error: (event, err) => {
                write("ERROR", process, run, describeEvent(templates, event), [err]);
                keep(run, { ...event, time: new Date().toISOString(), level: "ERROR", process, error: errorText(err) });
            },
            debug: (message, ...details) => {
                if (debug) write("DEBUG", process, run, message, details);
            },
        }),
        startRun: (run) => {
            const previous = readdirSync(dir).filter((f) => f.startsWith(`${run}-`) && f.endsWith(".log")).sort();
            for (const file of previous.slice(0, -(KEPT_RUNS - 1))) rmSync(join(dir, file));
            runFiles.set(run, join(dir, `${run}-${fileSafeTimestamp()}.log`));
            runRecords.set(run, []);
        },
        records: (run) => runRecords.get(run) ?? [],
    };
};
