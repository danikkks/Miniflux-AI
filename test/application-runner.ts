import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { eventually } from './mockserver.js';

type Env = Record<string, string>;

export const makeApplicationRunner = (root: string, webUrl: string, baseEnv: Env) => {
    let child: ChildProcess | undefined;
    let exited: Promise<unknown[]> = Promise.resolve([]);

    const launch = (env: Env = {}) => {
        child = spawn('node', ['dist/bootstrap.js'], {
            cwd: root,
            env: { ...process.env, ...baseEnv, ...env },
            stdio: 'pipe',
        });
        exited = once(child, 'exit');
    };

    const start = async (env: Env = {}) => {
        launch(env);
        await eventually(async () => {
            assert.equal(child?.exitCode, null, 'the app exited during startup');
            assert.ok((await fetch(`${webUrl}/process`)).ok);
        });
    };

    const processNow = async () => (await fetch(`${webUrl}/process`, { method: 'POST' })).text();

    const runFinished = (outcome: 'completed' | 'failed' = 'completed') =>
        eventually(async () => {
            assert.match(await (await fetch(`${webUrl}/process`)).text(), new RegExp(`processing ${outcome}`));
        });

    const stop = async () => {
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await exited;
    };

    return {
        launch,
        start,
        runFinished,
        stop,
        processNow,
        runOnce: async (env: Env = {}) => {
            await start(env);
            await processNow();
            await runFinished();
        },
        exitCode: async () => (await exited)[0],
    };
};
