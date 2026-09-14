/*
 * One machine, several agents.
 *
 * These run against a temporary HOME and the file store, never the login
 * keychain: a test suite that writes to somebody's real keychain is a test
 * suite nobody runs twice.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'cheto-credentials-'));

process.env.HOME = HOME;
process.env.CHETO_SECRET_STORE = 'file';

// After the environment, because the module resolves its paths at import.
const {
    forgetAgent,
    listAgentSessions,
    migrateLegacySession,
    rememberAgent,
    saveCredential,
    selectAgentSession,
} = await import('../src/credentials.js');

const CONFIG_DIR = join(HOME, '.config', 'cheto');
const SESSION = join(CONFIG_DIR, 'session.json');
const SECRETS = join(CONFIG_DIR, 'credentials.json');

const CHETO = 'https://cheto.example';

function secrets() {
    try {
        return JSON.parse(readFileSync(SECRETS, 'utf8'));
    } catch {
        return {};
    }
}

function reset() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SESSION, '{}');
    writeFileSync(SECRETS, '{}');
}

async function connect(handle, { workspace = 'demo', token = `cheto_ak_${handle}` } = {}) {
    await saveCredential(CHETO, handle, token);
    await rememberAgent({
        url: CHETO,
        handle,
        agent: handle,
        workspace,
        mention: `@${handle}`,
        connection: 'this machine',
    });
}

describe('two agents on one machine', () => {
    beforeEach(reset);

    it('keeps both, where connecting the second used to destroy the first', async () => {
        await connect('builder');
        await connect('rocky', { workspace: 'otro-espacio' });

        const sessions = await listAgentSessions();

        assert.deepEqual(
            sessions.map((entry) => entry.handle),
            ['builder', 'rocky'],
        );
        assert.equal(sessions[0].token, 'cheto_ak_builder');
        assert.equal(sessions[1].token, 'cheto_ak_rocky');
    });

    it('reconnecting the same agent replaces its row rather than adding one', async () => {
        await connect('rocky');
        await connect('rocky', { token: 'cheto_ak_rocky_2' });

        const sessions = await listAgentSessions();

        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].token, 'cheto_ak_rocky_2');
    });

    it('treats @Rocky and @rocky as the same participant', async () => {
        await connect('rocky');
        await saveCredential(CHETO, 'ROCKY', 'cheto_ak_shouting');

        const { session } = await selectAgentSession({ handle: 'RoCkY' });

        assert.equal(session.token, 'cheto_ak_shouting');
    });

    it('drops an agent whose credential has gone, rather than calling it connected', async () => {
        await connect('builder');
        await connect('rocky');

        writeFileSync(SECRETS, JSON.stringify({ [`${CHETO}#agent:rocky`]: 'cheto_ak_rocky' }));

        const sessions = await listAgentSessions();

        assert.deepEqual(
            sessions.map((entry) => entry.handle),
            ['rocky'],
        );
    });
});

describe('choosing which agent a command speaks as', () => {
    beforeEach(reset);

    it('takes --agent over everything else', async () => {
        await connect('builder');
        await connect('rocky');

        const { session, reason } = await selectAgentSession({ handle: 'rocky', preferred: 'builder' });

        assert.equal(reason, 'asked');
        assert.equal(session.handle, 'rocky');
    });

    it('falls back to the first entry in cheto.yml', async () => {
        await connect('builder');
        await connect('rocky');

        const { session, reason } = await selectAgentSession({ preferred: 'rocky' });

        assert.equal(reason, 'config');
        assert.equal(session.handle, 'rocky');
    });

    it('needs nothing when only one agent is connected', async () => {
        await connect('rocky');

        const { session, reason } = await selectAgentSession();

        assert.equal(reason, 'only');
        assert.equal(session.handle, 'rocky');
    });

    it('refuses rather than guessing when several are connected', async () => {
        await connect('builder');
        await connect('rocky');

        const { session, sessions, reason } = await selectAgentSession();

        assert.equal(reason, 'ambiguous');
        assert.equal(session, null);
        assert.equal(sessions.length, 2, 'the refusal has to be able to list them');
    });

    it('refuses a handle nobody here answers to', async () => {
        await connect('rocky');

        const { session, reason } = await selectAgentSession({ handle: 'kalel' });

        assert.equal(reason, 'unknown');
        assert.equal(session, null);
    });
});

describe('signing one agent out', () => {
    beforeEach(reset);

    it('leaves the other one connected', async () => {
        await connect('builder');
        await connect('rocky');

        await forgetAgent(CHETO, 'rocky');

        const sessions = await listAgentSessions();

        assert.deepEqual(
            sessions.map((entry) => entry.handle),
            ['builder'],
        );
        assert.equal(sessions[0].token, 'cheto_ak_builder');
    });

    it('takes the secret with it', async () => {
        await connect('rocky');
        await forgetAgent(CHETO, 'rocky');

        // The store removes the file once it holds nothing, so "gone" is two
        // shapes: an absent file, or one without this key.
        assert.equal(secrets()[`${CHETO}#agent:rocky`], undefined);
    });
});

describe('a machine connected before this existed', () => {
    beforeEach(reset);

    /** The old shape: one agent at the top level, its credential under the URL. */
    function legacy() {
        writeFileSync(
            SESSION,
            JSON.stringify({
                url: CHETO,
                agent: 'Builder',
                workspace: 'Demo',
                mention: '@builder',
                connection: 'MacBook Pro',
            }),
        );
        writeFileSync(SECRETS, JSON.stringify({ [CHETO]: 'cheto_ak_legacy' }));
    }

    it('still loads, with no migration and no reconnect', async () => {
        legacy();

        const sessions = await listAgentSessions();

        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].handle, 'builder');
        assert.equal(sessions[0].token, 'cheto_ak_legacy');
        assert.equal(sessions[0].legacy, true);
    });

    it('survives the arrival of a second agent, which is the whole bug', async () => {
        legacy();

        assert.equal(await migrateLegacySession(), 'builder');

        await connect('rocky');

        const sessions = await listAgentSessions();

        assert.deepEqual(
            sessions.map((entry) => entry.handle),
            ['builder', 'rocky'],
        );
        assert.equal(sessions[0].token, 'cheto_ak_legacy', 'the old credential is the same credential');
    });

    it('leaves the bare-URL key empty once moved, so nothing reads it twice', async () => {
        legacy();
        await migrateLegacySession();

        assert.equal(secrets()[CHETO], undefined);
        assert.equal(secrets()[`${CHETO}#agent:builder`], 'cheto_ak_legacy');
    });

    it('does nothing when there is nothing to move', async () => {
        await connect('rocky');

        assert.equal(await migrateLegacySession(), null);
    });

    it('does not come back after being signed out', async () => {
        legacy();
        await forgetAgent(CHETO, 'builder');

        assert.deepEqual(await listAgentSessions(), []);
    });
});
