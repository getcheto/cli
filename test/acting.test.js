/*
 * Which agent a command acts as, what goes on the wire, and what a 401 forgets.
 *
 * Against a temporary HOME and the file store, never the login keychain, and a
 * stubbed fetch: every assertion here is about the request this machine makes,
 * not about what a server would answer.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'cheto-acting-'));

process.env.HOME = HOME;
process.env.CHETO_SECRET_STORE = 'file';
delete process.env.CHETO_AGENT;
delete process.env.CHETO_WORKSPACE;

const { rememberAgent, saveCredential, saveSession, saveUserCredential, loadUserSession } = await import('../src/credentials.js');
const { requireSession, taskComment } = await import('../src/cli.js');
const agent = await import('../src/agent-commands.js');
const work = await import('../src/work.js');
const human = await import('../src/human.js');

const CONFIG_DIR = join(HOME, '.config', 'cheto');
const SECRETS = join(CONFIG_DIR, 'credentials.json');
const CHETO = 'https://cheto.example';

const ME = {
    agent: { id: 7, name: 'Rocky', slug: 'rocky' },
    workspace: { id: 1, slug: 'demo', name: 'Demo' },
    participants: [
        { type: 'user', id: 3, slug: 'ana', name: 'Ana' },
        { type: 'agent', id: 9, slug: 'magui', name: 'Magui' },
        { type: 'user', id: 4, slug: 'lucía', name: 'Lucía Gómez' },
    ],
    areas: [{ id: 16, slug: 'marketing', name: 'Marketing', statuses: [] }],
};

let calls;
let answer;
let output;
const original = { fetch: globalThis.fetch, log: console.log, error: console.error };

function secrets() {
    try {
        return JSON.parse(readFileSync(SECRETS, 'utf8'));
    } catch {
        return {};
    }
}

/** A fetch that records the request and answers with whatever `answer` says. */
function stubFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const call = {
            url: String(url),
            path: new URL(String(url)).pathname + new URL(String(url)).search,
            method: init.method ?? 'GET',
            headers: init.headers ?? {},
            body: init.body ? JSON.parse(init.body) : undefined,
        };

        calls.push(call);

        const { status = 200, body = {} } = answer(call);

        return new Response(JSON.stringify(body), { status });
    };
}

async function pair(handle, token = `cheto_ak_${handle}`) {
    await saveCredential(CHETO, handle, token);
    await rememberAgent({ url: CHETO, handle, agent: handle, workspace: 'demo', mention: `@${handle}` });
}

async function signIn(token = 'cheto_ut_person') {
    await saveUserCredential(CHETO, token);
    await saveSession({ url: CHETO, userUrl: CHETO, user: 'Ana' });
}

beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(join(CONFIG_DIR, 'session.json'), '{}');
    writeFileSync(SECRETS, '{}');
    delete process.env.CHETO_AGENT;
    delete process.env.CHETO_WORKSPACE;

    calls = [];
    output = [];
    answer = (call) => (call.path.endsWith('/me') ? { body: ME } : { body: { data: {} } });
    stubFetch();
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
});

afterEach(() => {
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
});

describe('choosing the agent', () => {
    it('uses a paired agent named by --agent, with its own token and no X-Cheto-Agent', async () => {
        await pair('rocky');
        await signIn();

        assert.equal(await taskComment(['12', 'hello', '--agent', 'rocky']), 0);

        const [call] = calls;

        assert.equal(call.headers.Authorization, 'Bearer cheto_ak_rocky');
        assert.equal(call.headers['X-Cheto-Agent'], undefined);
        // The flag value is not swallowed into the comment.
        assert.deepEqual(call.body, { body: 'hello' });
    });

    it('falls back to the person\'s login plus X-Cheto-Agent when the agent is not paired here', async () => {
        await signIn();

        assert.equal(await taskComment(['12', 'hello', '--agent', 'magui.b2c4@cheto', '--workspace', 'demo']), 0);

        const [call] = calls;

        assert.equal(call.url, `${CHETO}/api/v1/agent/tasks/12/comments`);
        assert.equal(call.headers.Authorization, 'Bearer cheto_ut_person');
        assert.equal(call.headers['X-Cheto-Agent'], 'magui.b2c4@cheto');
        assert.equal(call.headers['X-Cheto-Workspace'], 'demo');
    });

    it('takes CHETO_AGENT the same way as --agent', async () => {
        await signIn();
        process.env.CHETO_AGENT = 'magui.b2c4@cheto';

        const session = await requireSession([]);

        assert.equal(session.via, 'user');
        assert.equal(session.headers['X-Cheto-Agent'], 'magui.b2c4@cheto');
        assert.equal(session.headers['X-Cheto-Workspace'], undefined);
    });

    it('never turns a login into "some agent": no name and nothing paired is a refusal', async () => {
        await signIn();

        assert.equal(await requireSession([]), null);
        assert.equal(await taskComment(['12', 'hello']), 1);
        assert.equal(calls.length, 0);
        assert.match(output.join('\n'), /--agent <address>/);
        assert.match(output.join('\n'), /cheto agent list/);
    });

    it('through the login, a bare handle is refused before anything is sent', async () => {
        await signIn();

        for (const handle of ['magui', '@magui']) {
            assert.equal(await taskComment(['12', 'hi', '--agent', handle]), 1);
        }

        assert.equal(calls.length, 0);
        assert.match(output.join('\n'), /full address/);
    });

    it('refuses with nothing paired and nobody signed in, even when an agent is named', async () => {
        assert.equal(await requireSession(['--agent', 'magui']), null);
        assert.match(output.join('\n'), /cheto login/);
    });
});

describe('a 401 forgets the credential that was used, and nothing else does', () => {
    it('clears a paired agent\'s secret on 401 and leaves the others', async () => {
        await pair('rocky');
        await pair('qa');
        answer = () => ({ status: 401, body: { message: 'Unauthenticated.' } });

        assert.equal(await taskComment(['12', 'hi', '--agent', 'rocky']), 1);

        const left = secrets();

        assert.equal(left[`${CHETO}#agent:rocky`], undefined);
        assert.equal(left[`${CHETO}#agent:qa`], 'cheto_ak_qa');
        assert.match(output.join('\n'), /cheto connect/);
    });

    it('clears the person\'s login on 401 when acting through it', async () => {
        await signIn();
        await pair('qa');
        answer = () => ({ status: 401, body: { message: 'Unauthenticated.' } });

        assert.equal(await taskComment(['12', 'hi', '--agent', 'magui.b2c4@cheto']), 1);

        assert.equal(secrets()[`${CHETO}#user`], undefined);
        assert.equal(secrets()[`${CHETO}#agent:qa`], 'cheto_ak_qa');
        assert.match(output.join('\n'), /cheto login/);
    });

    it('clears the login on 401 from the human surface too', async () => {
        await signIn();
        answer = () => ({ status: 401, body: { message: 'Unauthenticated.' } });

        assert.equal(await human.agentList([]), 1);
        assert.equal(secrets()[`${CHETO}#user`], undefined);
    });

    for (const [status, error] of [
        [400, 'agent_required'],
        [403, 'missing_scope'],
        [404, 'no_such_agent'],
        [409, 'ambiguous_agent'],
    ]) {
        it(`keeps every credential on ${status} ${error}`, async () => {
            await signIn();
            await pair('rocky');
            answer = () => ({ status, body: { message: error, error } });

            assert.equal(await taskComment(['12', 'hi', '--agent', 'magui.b2c4@cheto']), 1);
            assert.equal(await taskComment(['12', 'hi', '--agent', 'rocky']), 1);

            assert.equal(secrets()[`${CHETO}#user`], 'cheto_ut_person');
            assert.equal(secrets()[`${CHETO}#agent:rocky`], 'cheto_ak_rocky');
        });
    }
});

describe('the login url survives connecting an agent elsewhere', () => {
    it('reads userUrl, not the url the last connect moved', async () => {
        await signIn();
        await saveCredential('https://other.example', 'x', 'cheto_ak_x');
        await rememberAgent({ url: 'https://other.example', handle: 'x' });

        assert.equal((await loadUserSession())?.url, CHETO);
    });
});

describe('login expiry', () => {
    const now = new Date('2026-09-23T12:00:00Z');

    it('warns under seven days and not before', () => {
        assert.equal(human.expiresSoon('2026-09-27T12:00:00Z', now), true);
        assert.equal(human.expiresSoon('2026-12-20T12:00:00Z', now), false);
        assert.equal(human.expiresSoon(null, now), false);
    });

    it('whoami prints when the login expires', async () => {
        await signIn();
        answer = () => ({
            body: {
                user: { name: 'Ana', email: 'ana@example.com' },
                scopes: ['agents:read', 'agents:act'],
                workspaces: [{ slug: 'demo' }],
                token: { expires_at: '2026-09-26T12:00:00Z' },
            },
        });

        assert.equal(await human.whoami([], { now }), 0);
        assert.match(output.join('\n'), /Expires: +2026-09-26/);
        assert.match(output.join('\n'), /less than 7 days/);
    });
});

/** Run a command as a paired agent and return the requests it made after identity lookups. */
async function asAgent(command, args) {
    await pair('rocky');

    const code = await command([...args, '--agent', 'rocky']);

    return { code, writes: calls.filter((call) => !call.path.endsWith('/me')), all: calls };
}

describe('agent commands send what the MCP tools send', () => {
    it('task list', async () => {
        const { code, writes } = await asAgent(agent.taskList, ['--assigned', 'me', '--area', 'Marketing', '--tag', 'reel', '--tag', 'urgent', '--all', '--limit', '5']);

        assert.equal(code, 0);
        assert.equal(writes[0].method, 'GET');

        const url = new URL(writes[0].url);

        assert.equal(url.pathname, '/api/v1/agent/tasks');
        assert.equal(url.searchParams.get('area'), 'marketing');
        assert.equal(url.searchParams.get('assigned'), 'me');
        assert.equal(url.searchParams.get('open'), 'false');
        assert.equal(url.searchParams.get('limit'), '5');
        assert.deepEqual(url.searchParams.getAll('tag[]'), ['reel', 'urgent']);
    });

    it('task show', async () => {
        answer = () => ({ body: { data: { id: 12, key: 'T-12', title: 'x', comments: [{ author: { name: 'Ana' }, body: 'ok' }] } } });

        const { code, writes } = await asAgent(agent.taskShow, ['12']);

        assert.equal(code, 0);
        assert.deepEqual([writes[0].method, writes[0].path], ['GET', '/api/v1/agent/tasks/12']);
        assert.match(output.join('\n'), /ok/);
    });

    it('task show refuses a key instead of a number, without a request', async () => {
        const { code, all } = await asAgent(agent.taskShow, ['MKT-12']);

        assert.equal(code, 1);
        assert.equal(all.length, 0);
    });

    it('task claim', async () => {
        const { writes } = await asAgent(agent.taskClaim, ['12']);

        assert.deepEqual([writes[0].method, writes[0].path], ['POST', '/api/v1/agent/tasks/12/claim']);
        assert.equal(writes[0].headers['Idempotency-Key'], 'cheto-claim-12');
    });

    it('task assign resolves an @handle through the participants', async () => {
        const { writes } = await asAgent(agent.taskAssign, ['12', '@magui']);

        assert.deepEqual([writes[0].method, writes[0].path], ['PATCH', '/api/v1/agent/tasks/12']);
        assert.deepEqual(writes[0].body, { assignee_type: 'agent', assignee_id: 9 });
    });

    it('task assign finds a handle with an accent when it is typed without one', async () => {
        const { writes } = await asAgent(agent.taskAssign, ['12', '@lucia']);

        assert.deepEqual(writes[0].body, { assignee_type: 'user', assignee_id: 4 });
    });

    it('task assign none unassigns', async () => {
        const { writes } = await asAgent(agent.taskAssign, ['12', 'none']);

        assert.deepEqual(writes[0].body, { assignee_type: null, assignee_id: null });
    });

    it('task update', async () => {
        const { writes } = await asAgent(agent.taskUpdate, ['12', '--title', 'New', '--priority', 'high', '--due', 'none', '--tag', 'a', '--tag', 'b', '--requires-human']);

        assert.deepEqual([writes[0].method, writes[0].path], ['PATCH', '/api/v1/agent/tasks/12']);
        assert.deepEqual(writes[0].body, { title: 'New', priority: 'high', due_on: null, tags: ['a', 'b'], requires_human: true });
    });

    it('review list, request and answer', async () => {
        let result = await asAgent(agent.reviewList, []);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['GET', '/api/v1/agent/reviews']);

        calls = [];
        result = await asAgent(agent.reviewRequest, ['12', '@ana', '--note', 'look at the copy']);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['POST', '/api/v1/agent/tasks/12/reviews']);
        assert.deepEqual(result.writes[0].body, { reviewer_type: 'user', reviewer_id: 3, note: 'look at the copy' });

        calls = [];
        result = await asAgent(agent.reviewAnswer, ['5', 'changes_requested', '--note', 'no']);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['PATCH', '/api/v1/agent/reviews/5']);
        assert.deepEqual(result.writes[0].body, { status: 'changes_requested', note: 'no' });
    });

    it('channel list, read and post', async () => {
        let result = await asAgent(agent.channelList, []);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['GET', '/api/v1/agent/channels']);

        calls = [];
        result = await asAgent(agent.channelRead, ['#general']);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['GET', '/api/v1/agent/channels/general/context']);

        calls = [];
        result = await asAgent(agent.channelPost, ['general', 'hola', '@ana']);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['POST', '/api/v1/agent/channels/general/messages']);
        assert.deepEqual(result.writes[0].body, { body: 'hola @ana' });
    });

    it('heartbeat and capacity', async () => {
        let result = await asAgent(agent.heartbeat, ['--status', 'busy']);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['POST', '/api/v1/agent/heartbeat']);
        assert.deepEqual(result.writes[0].body, { status: 'busy' });

        calls = [];
        result = await asAgent(agent.capacity, []);

        assert.deepEqual([result.writes[0].method, result.writes[0].path], ['GET', '/api/v1/agent/capacity']);
    });
});

describe('human commands go to /api/v1/cli with the person\'s token', () => {
    const BOARDS = {
        data: [
            {
                id: 16,
                uuid: 'b-16',
                slug: 'marketing',
                name: 'Marketing',
                statuses: [
                    { id: 77, name: 'Backlog', key: 'inbox' },
                    { id: 80, name: 'Listo', key: 'review' },
                ],
            },
        ],
    };

    beforeEach(async () => {
        await signIn();
        answer = (call) => (call.path.startsWith('/api/v1/cli/areas?') ? { body: BOARDS } : { body: { data: { id: 1 } } });
    });

    const last = () => calls.at(-1);

    it('area create, with columns', async () => {
        assert.equal(await work.areaCreate(['Reels', '--workspace', 'demo', '--column', 'Ideas:inbox', '--column', 'Posted:done']), 0);
        assert.deepEqual([last().method, last().path], ['POST', '/api/v1/cli/areas']);
        assert.deepEqual(last().body, {
            workspace: 'demo',
            name: 'Reels',
            columns: [
                { name: 'Ideas', category: 'inbox' },
                { name: 'Posted', category: 'done' },
            ],
        });
        assert.equal(last().headers.Authorization, 'Bearer cheto_ut_person');
        assert.equal(last().headers['X-Cheto-Agent'], undefined);
    });

    it('area list and update', async () => {
        assert.equal(await work.areaList(['--workspace', 'demo']), 0);
        assert.deepEqual([last().method, last().path], ['GET', '/api/v1/cli/areas?workspace=demo']);

        assert.equal(await work.areaUpdate(['b-16', '--name', 'Reels']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['PATCH', '/api/v1/cli/areas/b-16', { name: 'Reels' }]);
    });

    it('column add, update, reorder, remove', async () => {
        assert.equal(await work.columnAdd(['16', 'Blocked', 'in_progress']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['POST', '/api/v1/cli/areas/16/columns', { name: 'Blocked', category: 'in_progress' }]);

        assert.equal(await work.columnUpdate(['16', '80', '--category', 'review']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['PATCH', '/api/v1/cli/areas/16/columns/80', { category: 'review' }]);

        assert.equal(await work.columnReorder(['16', '80', '77']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['PUT', '/api/v1/cli/areas/16/columns', { order: [80, 77] }]);

        assert.equal(await work.columnRemove(['16', '80', '--into', '77']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['DELETE', '/api/v1/cli/areas/16/columns/80', { into: 77 }]);
    });

    it('user task create, update, delete, list', async () => {
        assert.equal(await work.userTaskCreate(['Imported', '--workspace', 'demo', '--area', 'Marketing', '--column', 'Listo', '--tag', 'x']), 0);
        assert.deepEqual([last().method, last().path], ['POST', '/api/v1/cli/tasks']);
        assert.deepEqual(last().body, { workspace: 'demo', title: 'Imported', tags: ['x'], work_area_status_id: 80 });

        assert.equal(await work.userTaskUpdate(['12', '--workspace', 'demo', '--column', 'Backlog', '--status', 'done', '--title', 'T']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['PATCH', '/api/v1/cli/tasks/12', { title: 'T', work_area_status_id: 77 }]);

        assert.equal(await work.userTaskDelete(['12']), 0);
        assert.deepEqual([last().method, last().path], ['DELETE', '/api/v1/cli/tasks/12']);

        assert.equal(await work.userTaskList(['--workspace', 'demo', '--area', 'marketing', '--open']), 0);
        assert.deepEqual([last().method, last().path], ['GET', '/api/v1/cli/tasks?workspace=demo&area=16&open=1']);
    });

    it('refuses without a workspace, before any request', async () => {
        assert.equal(await work.userTaskCreate(['Imported']), 1);
        assert.equal(calls.length, 0);
    });

    it('agent token', async () => {
        answer = () => ({ body: { token: 'cheto_ak_new', expires_at: null, membership: { mention: '@rocky', workspace: { slug: 'demo' } } } });

        assert.equal(await work.agentToken(['31', '--name', 'container', '--expires-days', '30']), 0);
        assert.deepEqual([last().method, last().path, last().body], ['POST', '/api/v1/cli/memberships/31/credentials', { name: 'container', expires_in_days: 30 }]);
    });

    it('agent list prints the address and each handle with its workspace', async () => {
        answer = () => ({
            body: {
                data: [
                    {
                        id: 4,
                        name: 'Rocky',
                        slug: 'rocky',
                        address: 'rocky.a7f3@cheto',
                        memberships: [{ id: 31, handle: 'rocky', mention: '@rocky', workspace: { slug: 'demo', name: 'Demo' }, presence: 'online', connections: [] }],
                    },
                ],
            },
        });

        assert.equal(await human.agentList([]), 0);
        assert.match(output.join('\n'), /address: rocky\.a7f3@cheto/);
        assert.match(output.join('\n'), /handle rocky in demo \(Demo\)/);
    });
});
