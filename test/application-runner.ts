import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { eventually } from './mockserver.js';

type Env = Record<string, string>;

export const makeApplicationRunner = (root: string, webUrl: string, baseEnv: Env) => {
    let child: ChildProcess | undefined;

    const start = (env: Env = {}) => {
        child = spawn('node', ['dist/bootstrap.js'], {
            cwd: root,
            env: { ...process.env, ...baseEnv, ...env },
            stdio: 'pipe',
        });
    };

    const runFinished = (outcome: 'completed' | 'failed' = 'completed') =>
        eventually(async () => {
            assert.match(await (await fetch(`${webUrl}/process`)).text(), new RegExp(`processing ${outcome}`));
        });

    const stop = async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
    };

    return {
        start,
        runFinished,
        stop,
        runOnce: async (env: Env = {}) => {
            start(env);
            await runFinished();
        },
        processNow: async () => (await fetch(`${webUrl}/process`, { method: 'POST' })).text(),
    };
};
