/**
 * Where the credential lives on this machine.
 *
 * The OS keychain first, because a bearer token is a password: whoever has it
 * is the agent. Keychain entries are encrypted at rest, unlocked with the
 * user's login, and invisible to a process that greps the home directory.
 *
 * A file is the fallback, at mode 600, and **it says so out loud**. A fallback
 * that happens quietly is one nobody knows they are relying on until they find
 * a token in a backup.
 *
 * Never the project directory, and never an environment variable — a child
 * process inherits the environment, and the child here is somebody else's
 * coding agent.
 */

import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SERVICE = 'cheto-bridge';
const CONFIG_DIR = join(homedir(), '.config', 'cheto');
const FALLBACK_FILE = join(CONFIG_DIR, 'credentials.json');

async function has(binary) {
    try {
        await run('which', [binary]);

        return true;
    } catch {
        return false;
    }
}

/** macOS: the login keychain, via the `security` binary. */
const macKeychain = {
    name: 'macOS Keychain',
    available: () => platform() === 'darwin' && has('security'),
    async read(account) {
        try {
            const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);

            return stdout.trim() || null;
        } catch {
            return null;
        }
    },
    async write(account, secret) {
        // `-U` updates in place; without it a second connect fails on a
        // duplicate rather than replacing the credential.
        await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret]);
    },
    async remove(account) {
        try {
            await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
        } catch {
            // Already gone is the outcome we wanted.
        }
    },
};

/** Linux: libsecret, via `secret-tool`. */
const secretTool = {
    name: 'libsecret',
    available: () => platform() === 'linux' && has('secret-tool'),
    async read(account) {
        try {
            const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);

            return stdout.trim() || null;
        } catch {
            return null;
        }
    },
    async write(account, secret) {
        await new Promise((resolve, reject) => {
            const child = execFile(
                'secret-tool',
                ['store', '--label', `Cheto (${account})`, 'service', SERVICE, 'account', account],
                (error) => (error ? reject(error) : resolve()),
            );
            child.stdin.write(secret);
            child.stdin.end();
        });
    },
    async remove(account) {
        try {
            await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
        } catch {
            // Already gone.
        }
    },
};

/** Anywhere else: a file only this user can read. */
const fileStore = {
    name: 'file (~/.config/cheto/credentials.json, mode 600)',
    available: async () => true,
    async read(account) {
        try {
            const raw = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));

            return raw[account] ?? null;
        } catch {
            return null;
        }
    },
    async write(account, secret) {
        await mkdir(dirname(FALLBACK_FILE), { recursive: true, mode: 0o700 });

        let existing = {};

        try {
            existing = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));
        } catch {
            // First credential on this machine.
        }

        existing[account] = secret;

        await writeFile(FALLBACK_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
        await chmod(FALLBACK_FILE, 0o600);
    },
    async remove(account) {
        try {
            const existing = JSON.parse(await readFile(FALLBACK_FILE, 'utf8'));
            delete existing[account];

            Object.keys(existing).length === 0
                ? await rm(FALLBACK_FILE, { force: true })
                : await writeFile(FALLBACK_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
        } catch {
            // Nothing stored.
        }
    },
};

/**
 * Which store, and the one way to override it.
 *
 * `CHETO_SECRET_STORE=file` forces the file store. Two real reasons: a container
 * with no keychain daemon, where the probe succeeds and the write then hangs;
 * and the tests, which must never reach the login keychain of whoever is
 * running them.
 */
async function pickStore() {
    if (process.env.CHETO_SECRET_STORE === 'file') {
        return fileStore;
    }

    for (const store of [macKeychain, secretTool, fileStore]) {
        if (await store.available()) {
            return store;
        }
    }

    return fileStore;
}

/**
 * The Cheto half of every key.
 *
 * One machine holds credentials for several installations — a staging Cheto and
 * a real one, most obviously — and neither may overwrite the other.
 */
function accountFor(url) {
    return String(url).replace(/\/+$/, '');
}

/**
 * One agent's key, on one Cheto.
 *
 * The handle is in the key because a machine runs **several** agents: three
 * roles in one repo, or one identity across three projects. `cheto.yml` has been
 * able to describe that since the config grew an `agents:` list, and until now
 * the credential store could not hold it — the second `cheto connect` silently
 * overwrote the first, and the agent you connected yesterday simply stopped
 * existing on this machine.
 *
 * Lower-cased because a handle is written by hand and `@Rocky` and `@rocky` are
 * the same participant.
 */
function agentAccountFor(url, handle) {
    return `${accountFor(url)}#agent:${String(handle ?? 'default').toLowerCase()}`;
}

/**
 * The human credential's account key.
 *
 * A `#user` suffix on the same URL, so one machine holds both an agent
 * credential and a human one for the same Cheto without either overwriting the
 * other. They are different principals and they must be storable side by side —
 * `cheto connect` arms a runtime, `cheto login` authorizes the person who runs it.
 */
function userAccountFor(url) {
    return `${accountFor(url)}#user`;
}

export async function saveUserCredential(url, token) {
    const store = await pickStore();
    await store.write(userAccountFor(url), token);

    return store.name;
}

export async function loadUserCredential(url) {
    const store = await pickStore();

    return store.read(userAccountFor(url));
}

export async function forgetUserCredential(url) {
    const store = await pickStore();
    await store.remove(userAccountFor(url));

    return store.name;
}

export async function saveCredential(url, handle, token) {
    const store = await pickStore();
    await store.write(agentAccountFor(url, handle), token);

    return store.name;
}

export async function loadCredential(url, handle) {
    const store = await pickStore();

    return store.read(agentAccountFor(url, handle));
}

export async function forgetCredential(url, handle) {
    const store = await pickStore();
    await store.remove(agentAccountFor(url, handle));

    return store.name;
}

export async function storeName() {
    return (await pickStore()).name;
}

// ── The session file ───────────────────────────────────────

const SESSION_FILE = join(CONFIG_DIR, 'session.json');

/**
 * The Chetos and agents this machine knows about. Only the tokens are secret.
 *
 *     {
 *       "url": "https://cheto.example",     // the last one touched
 *       "user": "Una persona",              // who is signed in, if anybody
 *       "agents": [
 *         { "url": "…", "handle": "builder", "workspace": "Demo", … }
 *       ]
 *     }
 *
 * A list rather than a map keyed by handle: this file is meant to be openable,
 * and a list of objects reads as a list of agents. Order is connection order,
 * which is also the order `cheto status` prints them in.
 */
async function readSessionFile() {
    try {
        return JSON.parse(await readFile(SESSION_FILE, 'utf8'));
    } catch {
        return null;
    }
}

async function writeSessionFile(contents) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await writeFile(SESSION_FILE, JSON.stringify(contents, null, 2), { mode: 0o600 });
}

/** The URL and the person, in plain sight. Used by `cheto login`. */
export async function saveSession(session) {
    await writeSessionFile({ ...((await readSessionFile()) ?? {}), ...session });
}

/**
 * Record an agent this machine has just connected.
 *
 * Upserts on (url, handle): reconnecting the same agent replaces its row rather
 * than growing a second one, which is what happens when a pairing code is
 * redeemed twice after a laptop is rebuilt.
 */
export async function rememberAgent(entry) {
    const file = (await readSessionFile()) ?? {};
    const agents = Array.isArray(file.agents) ? file.agents : [];
    const index = agents.findIndex((known) => sameAgent(known, entry));

    if (index === -1) {
        agents.push(entry);
    } else {
        agents[index] = { ...agents[index], ...entry };
    }

    await writeSessionFile({ ...file, url: entry.url, agents });
}

function sameAgent(a, b) {
    return accountFor(a.url ?? '') === accountFor(b.url ?? '')
        && String(a.handle ?? '').toLowerCase() === String(b.handle ?? '').toLowerCase();
}

/**
 * Every agent connected on this machine, with its credential.
 *
 * An entry whose credential has gone — revoked in Cheto, or removed from the
 * keychain by hand — is dropped rather than reported as connected. The file is
 * a note about what happened; the credential is what is true.
 */
export async function listAgentSessions() {
    const file = (await readSessionFile()) ?? {};
    const entries = Array.isArray(file.agents) ? file.agents : [];
    const found = [];

    for (const entry of entries) {
        const token = await loadCredential(entry.url, entry.handle);

        if (token) {
            found.push({ ...entry, token });
        }
    }

    if (found.length > 0 || !file.url) {
        return found;
    }

    /*
     * The shape from before one machine could hold two agents: a single agent
     * at the top level, its credential filed under the bare URL.
     *
     * Read here and never rewritten — `migrateLegacySession` does that, from
     * `connect`, where a write is expected. A machine that never connects
     * again keeps working from this branch forever, which is the point.
     */
    const legacy = await (await pickStore()).read(accountFor(file.url));

    return legacy
        ? [
              {
                  url: file.url,
                  handle: String(file.mention ?? '').replace(/^@/, '') || null,
                  agent: file.agent ?? null,
                  workspace: file.workspace ?? null,
                  mention: file.mention ?? null,
                  connection: file.connection ?? null,
                  token: legacy,
                  legacy: true,
              },
          ]
        : [];
}

/**
 * Move a pre-multi-agent credential into the new shape.
 *
 * Called before `connect` writes anything, so the agent already on this machine
 * survives the arrival of a second one. Under the old key it would not: the
 * new credential would be written to the same account and the old one would be
 * gone, with nothing to say it ever existed.
 */
export async function migrateLegacySession() {
    const file = await readSessionFile();

    if (!file?.url || (Array.isArray(file.agents) && file.agents.length > 0)) {
        return null;
    }

    const store = await pickStore();
    const legacy = await store.read(accountFor(file.url));

    if (!legacy) {
        return null;
    }

    const handle = String(file.mention ?? '').replace(/^@/, '') || 'default';

    await store.write(agentAccountFor(file.url, handle), legacy);
    await writeSessionFile({
        ...file,
        agents: [
            {
                url: file.url,
                handle,
                agent: file.agent ?? null,
                workspace: file.workspace ?? null,
                mention: file.mention ?? null,
                connection: file.connection ?? null,
            },
        ],
    });
    await store.remove(accountFor(file.url));

    return handle;
}

/**
 * Which agent a command acts as.
 *
 * Three ways to decide, in order, and a refusal rather than a guess:
 *
 *   1. `--agent <handle>`, which is a person saying so.
 *   2. The first entry in `cheto.yml`, which is this checkout saying so.
 *   3. The only one connected, when there is only one.
 *
 * When none of those settles it the answer is `ambiguous`, never "the first
 * one". A command that quietly comments as the wrong agent is worse than one
 * that stops and asks which.
 */
export async function selectAgentSession({ handle = null, preferred = null } = {}) {
    const sessions = await listAgentSessions();

    if (sessions.length === 0) {
        return { session: null, sessions, reason: 'none' };
    }

    if (handle) {
        const match = sessions.find((entry) => matches(entry, handle));

        return match ? { session: match, sessions, reason: 'asked' } : { session: null, sessions, reason: 'unknown' };
    }

    if (preferred) {
        const match = sessions.find((entry) => matches(entry, preferred));

        if (match) {
            return { session: match, sessions, reason: 'config' };
        }
    }

    return sessions.length === 1
        ? { session: sessions[0], sessions, reason: 'only' }
        : { session: null, sessions, reason: 'ambiguous' };
}

function matches(entry, handle) {
    return String(entry.handle ?? '').toLowerCase() === String(handle).toLowerCase();
}

/**
 * The person signed in on this machine, and their credential.
 *
 * Separate from the agents, and neither implies the other: you can be logged in
 * as yourself with no runtime connected, and a server can run three connected
 * agents with nobody logged in.
 */
export async function loadUserSession() {
    const config = await readSessionFile();

    if (!config?.url) {
        return null;
    }

    const token = await loadUserCredential(config.url);

    return token ? { url: config.url, user: config.user ?? null, token } : null;
}

/** Forget one agent: its credential, and its row in the session file. */
export async function forgetAgent(url, handle) {
    const store = await pickStore();

    await store.remove(agentAccountFor(url, handle));
    // The pre-multi-agent key, for a machine that never reconnected.
    await store.remove(accountFor(url));

    const file = (await readSessionFile()) ?? {};
    const agents = (Array.isArray(file.agents) ? file.agents : []).filter(
        (entry) => !sameAgent(entry, { url, handle }),
    );

    // The top-level agent fields belong to the shape this replaces. Dropping
    // them here is what stops a forgotten agent reappearing from the legacy
    // branch of `listAgentSessions`.
    const { agent, workspace, mention, connection, ...rest } = file;

    await writeSessionFile({ ...rest, agents });

    return store.name;
}

export const CONFIG_HOME = CONFIG_DIR;
