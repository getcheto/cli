/**
 * `knot.yml` — which agent runtime to run, and where.
 *
 * A deliberately tiny YAML reader rather than a dependency. The schema is nine
 * keys and two levels deep; pulling in a parser for that would be the only
 * thing in this package with a package tree, and "no install step" is the
 * feature.
 *
 * It handles exactly what the documented schema uses: nested maps by
 * indentation, scalars, and inline `['a', 'b']` lists. Anything else is a
 * clear error rather than a wrong guess — a config file that silently parses
 * into something you did not write is worse than one that refuses.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_HOME } from './credentials.js';
import { DEFAULT_MODE, MODES } from './policy.js';

/** `- key: value` opens a map; anything else in a list is a plain value. */
const MAP_ITEM = /^[A-Za-z0-9_.-]+:(\s|$)/;

export function parseSimpleYaml(source) {
    const root = {};

    // Each frame is a container and the indentation it lives at. `parent` and
    // `key` are kept so a map created for `agents:` can be turned into a list
    // the moment the first `- ` shows up — which is the only point at which
    // that is knowable.
    const stack = [{ indent: -1, node: root, parent: null, key: null }];

    const lines = source.split('\n');

    lines.forEach((rawLine, index) => {
        const withoutComment = rawLine.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');

        if (withoutComment.trim() === '') {
            return;
        }

        const indent = withoutComment.length - withoutComment.trimStart().length;
        const line = withoutComment.trim();

        // Close every container this line has stepped back out of.
        while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
            stack.pop();
        }

        if (line.startsWith('- ') || line === '-') {
            let frame = stack[stack.length - 1];

            if (!Array.isArray(frame.node)) {
                if (frame.parent === null) {
                    throw new Error(`knot.yml line ${index + 1}: a list needs a key above it`);
                }

                const list = [];
                frame.parent[frame.key] = list;
                frame.node = list;
            }

            const rest = line.slice(1).trim();

            // Two kinds of list item, and they are told apart by shape rather
            // than by which key they sit under: `- agent: qa` opens a map,
            // `- inbox` is a value. Filters are written the second way and
            // agents the first, and both have to work in one file.
            if (rest !== '' && !MAP_ITEM.test(rest)) {
                frame.node.push(parseScalar(rest));

                return;
            }

            const item = {};
            frame.node.push(item);
            stack.push({ indent, node: item, parent: frame.node, key: frame.node.length - 1 });

            if (rest !== '') {
                assign(stack, rest, indent + 2, index);
            }

            return;
        }

        assign(stack, line, indent, index);
    });

    return root;
}

/** One `key: value` line, into whatever container is currently open. */
function assign(stack, line, indent, index) {
    const separator = line.indexOf(':');

    if (separator === -1) {
        throw new Error(`knot.yml line ${index + 1}: expected "key: value", got "${line}"`);
    }

    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const frame = stack[stack.length - 1];

    if (Array.isArray(frame.node)) {
        throw new Error(`knot.yml line ${index + 1}: "${key}" is inside a list; every item needs its own "- "`);
    }

    if (rawValue === '') {
        // A map until proven otherwise. The next line decides.
        frame.node[key] = {};
        stack.push({ indent, node: frame.node[key], parent: frame.node, key });

        return;
    }

    frame.node[key] = parseScalar(rawValue);
}

function parseScalar(value) {
    if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();

        return inner === '' ? [] : inner.split(',').map((item) => parseScalar(item.trim()));
    }

    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
        return value.slice(1, -1);
    }

    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+$/.test(value)) return Number(value);

    return value;
}

/** `~/…` is what people write in a config file; Node does not expand it. */
export function expandHome(path) {
    if (typeof path !== 'string') {
        return path;
    }

    return path.startsWith('~') ? join(homedir(), path.slice(1)) : path;
}

/**
 * The nearest config, or null.
 *
 * The working directory first, so a checkout can carry the agent it belongs to
 * — which is how Lucía's Mac and Diego's PC end up running different agents
 * against the same Knot without either of them configuring anything global.
 *
 * Two shapes, and the single-agent one keeps working exactly as it did:
 *
 *     agent: qa-demo            # one agent, top level
 *     runtime: { … }
 *
 *     agents:                    # several, each with its own runtime
 *       - agent: qa-demo
 *         workspace: demo
 *         runtime: { … }
 *         cadence: poll
 *
 * One machine now serves several memberships — three roles in one repo, or one
 * agent across three projects — and both directions are real.
 */
export async function loadConfig(cwd = process.cwd()) {
    for (const candidate of [join(cwd, 'knot.yml'), join(cwd, 'knot.yaml'), join(CONFIG_HOME, 'knot.yml')]) {
        let parsed;

        try {
            parsed = parseSimpleYaml(await readFile(candidate, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }

            throw error;
        }

        const entries = Array.isArray(parsed.agents) && parsed.agents.length > 0 ? parsed.agents : [parsed];

        const agents = entries.map((entry) => ({
            agent: entry.agent ?? null,
            workspace: entry.workspace?.name ?? (typeof entry.workspace === 'string' ? entry.workspace : null),
            runtime: entry.runtime ?? entry.parent?.runtime ?? parsed.runtime ?? null,

            // What this machine may do without being asked. Absent means
            // `notify`: chat can reach the agent, work cannot start itself.
            // Inherited from the top of the file so a machine can set one
            // policy for every agent it runs and override it per agent.
            mode: entry.mode ?? parsed.mode ?? DEFAULT_MODE,

            // Opt-in task automation, and the default that matters most:
            // absent is off. A config that says nothing must never mean yes.
            automation: entry.automation ?? parsed.automation ?? null,

            // `poll` holds the connection and answers in about a second;
            // `cron` wakes on a schedule and accepts slow replies. How often
            // you run it — `mode` is what it may do when you do.
            cadence: entry.cadence ?? parsed.cadence ?? 'poll',
            workspacePath: entry.workspace?.path ? resolve(expandHome(entry.workspace.path)) : cwd,
        }));

        agents.forEach((entry) => assertMode(entry, candidate));

        return {
            path: candidate,
            agents,

            // The first one, for every command that acts on "the" agent. A
            // machine running several still has one it reaches by default.
            agent: agents[0].agent,
            runtime: agents[0].runtime,
            mode: agents[0].mode,
            automation: agents[0].automation,
            cadence: agents[0].cadence,
            workspacePath: agents[0].workspacePath,
        };
    }

    return null;
}

/**
 * A mode nobody can typo into something more permissive.
 *
 * `mode: notifiy` must not silently fall back to a default, and `mode: Auto`
 * on a machine the owner believed was passive is the one mistake this file can
 * make that has consequences. So it refuses, by name, at load time.
 */
function assertMode(entry, path) {
    if (!MODES.includes(String(entry.mode).toLowerCase())) {
        throw new Error(`${path}: mode "${entry.mode}" is not one of ${MODES.join(', ')}`);
    }

    entry.mode = String(entry.mode).toLowerCase();
}
