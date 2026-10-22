import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatWithOptions } from "node:util";
import type { ILogger } from "./core/entities.js";

type Level = "INFO" | "DEBUG" | "ERROR";

const KEPT_RUNS = 10;

const INSPECT = { depth: null, maxArrayLength: null, maxStringLength: null, breakLength: 120 };

const fileSafeTimestamp = () => new Date().toISOString().replaceAll(":", "-");

export type Logs = {
    logger(process: string, run?: string): ILogger;
    startRun(run: string): void;
};

export const makeLogs = (dir: string, debug: boolean): Logs => {
    mkdirSync(dir, { recursive: true });
    const runFiles = new Map<string, string>();

    const write = (level: Level, process: string, run: string, message: string, details: unknown[]) => {
        const line = `${new Date().toISOString()} ${level.padEnd(5)} [${process}] ${formatWithOptions(INSPECT, message, ...details)}\n`;
        (level === "ERROR" ? globalThis.process.stderr : globalThis.process.stdout).write(line);
        appendFileSync(runFiles.get(run) ?? join(dir, `${run}.log`), line);
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
        startRun: (run) => {
            const previous = readdirSync(dir).filter((f) => f.startsWith(`${run}-`) && f.endsWith(".log")).sort();
            for (const file of previous.slice(0, -(KEPT_RUNS - 1))) rmSync(join(dir, file));
            runFiles.set(run, join(dir, `${run}-${fileSafeTimestamp()}.log`));
        },
    };
};
