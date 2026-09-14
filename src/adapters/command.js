/**
 * The only adapter, and on purpose.
 *
 * A bridge that knows about Claude is a bridge somebody has to rewrite for
 * Codex, and again for the next one. Every coding agent worth connecting reads
 * a prompt and writes a result, so that is the whole contract:
 *
 *     stdin  ← the prompt
 *     stdout → whatever it wants to report back
 *
 * `claude`, `codex`, `opencode`, `apx exec`, and a shell script somebody wrote
 * this morning all satisfy it without knowing Cheto exists.
 */

import { spawn } from 'node:child_process';

export function runCommand({ command, args = [], cwd, prompt, timeoutMs = 15 * 60 * 1000, env = process.env }) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            // The credential is deliberately absent from the child's
            // environment. The agent is being asked to do work, not handed the
            // ability to act as itself in Cheto behind the bridge's back.
            env: { ...env, CHETO_TOKEN: undefined },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let finished = false;

        const timer = setTimeout(() => {
            if (!finished) {
                child.kill('SIGTERM');
                // A hung agent should not hold the loop forever, and SIGTERM
                // is a request; SIGKILL five seconds later is the answer.
                setTimeout(() => child.kill('SIGKILL'), 5000);
            }
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            finished = true;
            clearTimeout(timer);
            resolve({ ok: false, output: '', error: `could not start "${command}": ${error.message}` });
        });

        child.on('close', (code) => {
            finished = true;
            clearTimeout(timer);
            resolve({
                ok: code === 0,
                output: stdout.trim(),
                error: code === 0 ? null : stderr.trim() || `exited with code ${code}`,
            });
        });

        child.stdin.write(prompt);
        child.stdin.end();
    });
}

export function describeRuntime(runtime) {
    if (!runtime || runtime.type !== 'command' || !runtime.command) {
        return null;
    }

    return [runtime.command, ...(runtime.args ?? [])].join(' ');
}
