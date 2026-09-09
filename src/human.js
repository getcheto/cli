/**
 * The commands a person runs, as themselves.
 *
 * Kept apart from the agent commands in `cli.js` on purpose, and the separation
 * mirrors the server's: two guards, two tokens, two clients. **Only these can
 * create an agent**, because minting a new participant is a human action — a
 * leaked machine credential that could do it would turn one laptop into an
 * unbounded number of participants.
 */

import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, extname } from 'node:path';
import { KnotError, KnotUserApi } from './api.js';
import {
    forgetUserCredential,
    listAgentSessions,
    loadUserSession,
    saveSession,
    saveUserCredential,
    storeName,
} from './credentials.js';
import { expandHome, loadConfig } from './config.js';

const log = (...args) => console.log(...args);
const warn = (...args) => console.error(...args);

/**
 * `knot login` — authorize this terminal, through a browser.
 *
 * The device flow. Nothing is typed in here but the command: the CLI asks for a
 * code, the person approves it in a browser they are already signed in to, and
 * the CLI collects a scoped credential.
 *
 * Chosen over a loopback redirect because a Knot agent frequently runs where
 * there is no browser — a server, a container, an SSH session — and this is the
 * flow that still works there, since the approval happens on whatever device
 * the person is holding.
 */
export async function login(args = []) {
    const url = flag(args, '--url') ?? (await loadUserSession())?.url ?? (await ask('Knot URL: '));

    if (!url) {
        warn('A Knot URL is required: knot login --url https://knot.example');

        return 1;
    }

    const machine = flag(args, '--machine') ?? hostname();

    let started;

    try {
        started = await KnotUserApi.startLogin(url, machine);
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }

    log('');
    log('  Open this and approve it:');
    log(`    ${started.verification_uri_complete}`);
    log('');
    log(`  Code: ${started.user_code}`);
    log(`  Check that this is the code the page shows you.`);
    log('');
    log('  Waiting…');

    // Nice to have, never required: on a machine with no browser this quietly
    // does nothing and the URL above is still the answer.
    await openInBrowser(started.verification_uri_complete);

    const deadline = Date.now() + started.expires_in * 1000;
    const interval = Math.max(1, Number(started.interval) || 3) * 1000;

    while (Date.now() < deadline) {
        await sleep(interval);

        let collected;

        try {
            collected = await KnotUserApi.collect(url, started.device_code);
        } catch (error) {
            warn('');
            warn(error instanceof KnotError ? error.message : String(error));

            return 1;
        }

        if (collected === null) {
            continue;
        }

        // Straight to the keychain. It is never printed, so there is nothing
        // for a screen recording or a shell history to keep.
        const store = await saveUserCredential(url, collected.token);
        await saveSession({ url, user: collected.user.name });

        log('');
        log(`  Signed in as ${collected.user.name} <${collected.user.email}>`);
        log(`  Credential stored in: ${store}`);
        log(`  Can: ${collected.scopes.join(', ')}`);
        log('');
        log('  Next: knot agent create "Builder" --workspace demo');
        log('');

        return 0;
    }

    warn('');
    warn('Timed out waiting for approval. Run knot login again.');

    return 1;
}

/** `knot whoami` — who this machine is signed in as, and what it runs. */
export async function whoami() {
    const session = await loadUserSession();
    const config = await loadConfig();

    if (!session) {
        log('');
        log('  Not signed in. Run: knot login');
        log('');
    } else {
        const api = new KnotUserApi({ url: session.url, token: session.token });

        try {
            const me = await api.me();

            log('');
            log(`  Knot:       ${session.url}`);
            log(`  Signed in:  ${me.user.name} <${me.user.email}>`);
            log(`  Can:        ${me.scopes.join(', ')}`);
            log(`  Workspaces: ${me.workspaces.map((workspace) => workspace.slug).join(', ') || 'none'}`);
            log(`  Secrets:    ${await storeName()}`);
            log('');
        } catch (error) {
            warn(error instanceof KnotError ? error.message : String(error));

            return 1;
        }
    }

    // What is actually armed here, which is a different question again. A
    // credential exists or it does not; `knot.yml` only says what would be run
    // if one did.
    const connected = await listAgentSessions();

    if (connected.length > 0) {
        log('  Connected agents on this machine:');
        connected.forEach((entry) => {
            log(`    @${entry.handle ?? '?'}  ${entry.agent ?? ''}  in ${entry.workspace ?? '?'}  ·  ${entry.connection ?? 'this machine'}`);
        });
        log('  Any command takes --agent <handle>.');
        log('');
    }

    // What this checkout would run, which is a different question from who you
    // are. A machine with no config runs nothing, and saying so is the point.
    if (config) {
        log(`  Config:     ${config.path}`);
        config.agents.forEach((entry) => {
            log(`    @${entry.agent ?? '(unset)'}  ${entry.workspace ?? ''}  ${describe(entry.runtime)}  cadence: ${entry.cadence}`);
        });
        log('');
    } else {
        log('  No knot.yml here — nothing would run on this machine.');
        log('');
    }

    return 0;
}

/** `knot agent list` — the agents you own, and where each one works. */
export async function agentList() {
    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const { data } = await api.agents();

        if (data.length === 0) {
            log('No agents yet. Create one: knot agent create "Builder" --workspace demo');

            return 0;
        }

        log('');

        data.forEach((agent) => {
            // The id is printed because `agent update` and `agent avatar` ask
            // for it, and a list that names the ids it needs is the difference
            // between one command and a trip through the API.
            log(`  ${agent.name}  (${agent.slug})  ·  agent ${agent.id}`);

            if (agent.memberships.length === 0) {
                log('    not in any workspace yet');
            }

            agent.memberships.forEach((membership) => {
                const live = membership.connections.filter((connection) => !connection.revoked_at);

                log(`    ${membership.mention} in ${membership.workspace?.slug ?? '?'}  ·  ${membership.presence}  ·  membership ${membership.id}`);

                live.forEach((connection) => {
                    log(`      ${connection.status.value === 'offline' ? '○' : '●'} ${connection.label} — ${connection.runtime_name ?? 'unknown runtime'} · connection ${connection.id}`);
                });
            });

            log('');
        });

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/** `knot agent create <name> --workspace <slug|uuid>` */
export async function agentCreate(args = []) {
    // The name is positional and comes first. Everything after it is flags,
    // so anything starting with `--` is not a name.
    const name = args[0] && !args[0].startsWith('--') ? args[0] : null;

    if (!name) {
        warn('Usage: knot agent create "Builder" --workspace demo [--handle builder] [--charter "…"]');

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const created = await api.createAgent({
            name,
            workspace: flag(args, '--workspace') ?? undefined,
            handle: flag(args, '--handle') ?? undefined,
            charter: flag(args, '--charter') ?? undefined,
            description: flag(args, '--description') ?? undefined,
        });

        log('');
        log(`  Created ${created.agent.name}  (${created.agent.slug})`);

        if (created.membership) {
            log(`  ${created.membership.mention} in ${created.membership.workspace?.slug ?? '?'}`);
            log('');
            log(`  Next: knot agent pair ${created.membership.id}`);
        } else {
            log('  Not in a workspace yet. Add it with --workspace, or:');
            log(`    knot agent join ${created.agent.id} --workspace demo`);
        }

        log('');

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/**
 * `knot agent update <agent-id>` — fix an agent's details without a browser.
 *
 * The two objects the panel shows on one card are two things here, and the
 * flags say which: `--name` and `--description` belong to the identity and
 * follow it into every workspace; `--handle` and `--charter` belong to one
 * membership, so they need `--workspace` to say which.
 */
export async function agentUpdate(args = []) {
    const agentId = args[0] && !args[0].startsWith('--') ? args[0] : null;

    if (!agentId) {
        warn('Usage: knot agent update <agent-id> [--name "Rocky"] [--description "…"]');
        warn('                                    [--workspace otro-espacio --handle rocky --charter "…"]');
        warn('Ids come from: knot agent list');

        return 1;
    }

    const changes = {
        name: flag(args, '--name') ?? undefined,
        description: flag(args, '--description') ?? undefined,
        workspace: flag(args, '--workspace') ?? undefined,
        handle: flag(args, '--handle') ?? undefined,
        charter: flag(args, '--charter') ?? undefined,
    };

    if (Object.values(changes).every((value) => value === undefined)) {
        warn('Nothing to change. Pass at least one of --name, --description, --handle, --charter.');

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const { agent, membership } = await api.updateAgent(agentId, changes);

        log('');
        log(`  ${agent.name}  (${agent.slug})`);

        if (agent.description) {
            log(`  ${agent.description}`);
        }

        if (membership) {
            log(`  ${membership.mention} in ${membership.workspace?.slug ?? '?'}`);

            if (membership.charter) {
                log(`  Charter: ${membership.charter}`);
            }
        }

        log('');

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/**
 * `knot agent avatar <agent-id> <file>` — give an agent a face.
 *
 * The file is read here and uploaded. Handing the server a URL to fetch would
 * be less typing and an SSRF: an avatar is not worth teaching Knot to make
 * requests on somebody else's behalf.
 */
export async function agentAvatar(args = []) {
    const [agentId, file] = args.filter((argument) => !argument.startsWith('--'));

    if (!agentId || !file) {
        warn('Usage: knot agent avatar <agent-id> ./rocky.png');
        warn('PNG, JPEG or WebP, up to 2 MB.');

        return 1;
    }

    const path = expandHome(file);
    let bytes;

    try {
        bytes = await readFile(path);
    } catch {
        warn(`Cannot read ${path}`);

        return 1;
    }

    const type = MIME[extname(path).toLowerCase()];

    if (!type) {
        warn(`${extname(path) || 'That file'} is not an image Knot accepts. Use PNG, JPEG or WebP.`);

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    const form = new FormData();
    form.append('avatar', new Blob([bytes], { type }), basename(path));

    try {
        const { agent } = await api.uploadAvatar(agentId, form);

        log(`  ${agent.name} has a face now: ${agent.avatar_url}`);

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/** What the server accepts, by extension. Kept in step with the validator. */
const MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};

/** `knot agent join <agent-id> --workspace <slug|uuid>` */
export async function agentJoin(args = []) {
    const agentId = args[0];
    const workspace = flag(args, '--workspace');

    if (!agentId || !workspace) {
        warn('Usage: knot agent join <agent-id> --workspace demo [--handle qa]');

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const { membership } = await api.join(agentId, {
            workspace,
            handle: flag(args, '--handle') ?? undefined,
            charter: flag(args, '--charter') ?? undefined,
        });

        log(`  ${membership.mention} in ${membership.workspace?.slug ?? '?'}  ·  membership ${membership.id}`);
        log(`  Next: knot agent pair ${membership.id}`);

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/**
 * `knot agent pair <membership-id>` — a code for a machine to redeem.
 *
 * The code is printed because it is meant to be typed into another terminal.
 * It is single-use and dies in fifteen minutes, so the copy it leaves in shell
 * history is worthless the moment the machine has connected.
 */
export async function agentPair(args = []) {
    const membershipId = args[0];

    if (!membershipId) {
        warn('Usage: knot agent pair <membership-id>     (knot agent list shows them)');

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const issued = await api.pair(membershipId);

        log('');
        log(`  Connect a machine to ${issued.membership.mention} in ${issued.membership.workspace?.slug ?? '?'}:`);
        log('');
        log(`    knot connect ${issued.code}`);
        log('');
        log(`  Single use. Expires ${new Date(issued.expires_at).toLocaleTimeString()}.`);
        log('');

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/** `knot agent disconnect <connection-id>` — disarm one machine. */
export async function agentDisconnect(args = []) {
    const connectionId = args[0];

    if (!connectionId) {
        warn('Usage: knot agent disconnect <connection-id>     (knot agent list shows them)');

        return 1;
    }

    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        const { connection } = await api.disconnect(connectionId);

        log(`  Disarmed ${connection.label}. Other machines running the same agent are unaffected.`);

        return 0;
    } catch (error) {
        warn(error instanceof KnotError ? error.message : String(error));

        return 1;
    }
}

/** `knot logout --user` — forget the human credential on this machine. */
export async function userLogout() {
    const session = await loadUserSession();

    if (!session) {
        log('Not signed in.');

        return 0;
    }

    const store = await forgetUserCredential(session.url);

    log(`Signed out. Credential removed from ${store}.`);
    log('It still exists in Knot — revoke it there if this machine is gone for good.');

    return 0;
}

async function requireUser() {
    const session = await loadUserSession();

    if (!session) {
        warn('Not signed in. Run: knot login');

        return null;
    }

    return new KnotUserApi({ url: session.url, token: session.token });
}

function describe(runtime) {
    if (!runtime || runtime.type !== 'command') {
        return 'no runtime';
    }

    return [runtime.command, ...(runtime.args ?? [])].join(' ');
}

/**
 * Open the approval page, if this machine has a browser.
 *
 * Best effort by design: on a server this fails and the printed URL is still
 * the whole answer. Never a requirement, and never an error.
 */
async function openInBrowser(url) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

    try {
        const { spawn } = await import('node:child_process');
        spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    } catch {
        // No browser here. The URL is printed above.
    }
}

function flag(args, name) {
    const index = args.indexOf(name);

    return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ask(question) {
    return new Promise((resolve) => {
        process.stdout.write(question);
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (data) => resolve(data.trim()));
    });
}
