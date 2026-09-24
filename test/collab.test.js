/*
 * The commands added for "everyone can use the whole system from a terminal":
 * an agent deleting, updating memory and reshaping boards; the person doing
 * the rest of the work as themselves; which surface a board command reaches;
 * capabilities; and what a missing scope says.
 *
 * Temporary HOME, the file secret store and a stubbed fetch, as acting.test.js.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const HOME = mkdtempSync(join(tmpdir(), 'cheto-collab-'));

process.env.HOME = HOME;
process.env.CHETO_SECRET_STORE = 'file';
delete process.env.CHETO_AGENT;
delete process.env.CHETO_WORKSPACE;

const { rememberAgent, saveCredential, saveSession, saveUserCredential } = await import('../src/credentials.js');
const { status } = await import('../src/cli.js');
const agent = await import('../src/agent-commands.js');
const work = await import('../src/work.js');
const collab = await import('../src/collab.js');
const human = await import('../src/human.js');

const CONFIG_DIR = join(HOME, '.config', 'cheto');
const SECRETS = join(CONFIG_DIR, 'credentials.json');
const CHETO = 'https://cheto.example';

const AGENT_ME = {
    agent: { id: 7, name: 'Rocky', slug: 'rocky', status: { value: 'online' } },
    workspace: { id: 1, slug: 'demo', name: 'Demo' },
    membership: { id: 31, handle: 'rocky', capabilities: ['tasks.create', 'boards.manage'] },
    participants: [
        { type: 'user', id: 3, slug: 'ana', name: 'Ana' },
        { type: 'agent', id: 9, slug: 'magui', name: 'Magui' },
    ],
    areas: [{ id: 16, slug: 'marketing', name: 'Marketing', statuses: [{ id: 77, name: 'Backlog', key: 'inbox' }] }],
};

const USER_ME = { user: { id: 3, name: 'Ana', email: 'ana@example.com' }, scopes: [], workspaces: [{ slug: 'demo' }] };

const OWN_AGENTS = {
    data: [
        { id: 9, name: 'Magui', slug: 'magui', address: 'magui.b2c4@cheto', memberships: [{ id: 40, handle: 'magui', workspace: { slug: 'demo', uuid: 'w-1' } }] },
        { id: 11, name: 'Other', slug: 'other', address: 'other.0000@cheto', memberships: [{ id: 41, handle: 'rocky', workspace: { slug: 'elsewhere', uuid: 'w-2' } }] },
    ],
};

const CHANNELS = { data: [{ id: 5, slug: 'general', name: 'General' }] };

let calls;
let answer;
let output;
const original = { fetch: globalThis.fetch, log: console.log, error: console.error };

function stubFetch() {
    globalThis.fetch = async (url, init = {}) => {
        const parsed = new URL(String(url));
        const call = {
            url: String(url),
            path: parsed.pathname + parsed.search,
            pathname: parsed.pathname,
            method: init.method ?? 'GET',
            headers: init.headers ?? {},
            body: init.body ? JSON.parse(init.body) : undefined,
        };

        calls.push(call);

        const { status: code = 200, body = {} } = answer(call);

        return new Response(JSON.stringify(body), { status: code });
    };
}

function defaultAnswer(call) {
    if (call.pathname === '/api/v1/agent/me') return { body: AGENT_ME };
    if (call.pathname === '/api/v1/cli/me') return { body: USER_ME };
    if (call.pathname === '/api/v1/cli/agents') return { body: OWN_AGENTS };
    if (call.pathname === '/api/v1/cli/channels') return { body: CHANNELS };
    if (call.pathname.endsWith('/search')) return { body: { total: 1, matched_by: 'like', results: [{ kind: 'task', title: 'x', excerpt: 'y' }] } };
    if (call.pathname.endsWith('/context')) return { body: { compacts: [], messages: [{ author: { name: 'Ana' }, body: 'hola' }] } };
    if (call.pathname === '/api/v1/cli/inbox') return { body: { tasks: [], reviews: [], unread_notifications: 2 } };

    return { body: { data: { id: 1, key: 'T-1', title: 't' } } };
}

async function pair(handle, token = `cheto_ak_${handle}`) {
    await saveCredential(CHETO, handle, token);
    await rememberAgent({ url: CHETO, handle, agent: handle, workspace: 'demo', mention: `@${handle}` });
}

async function signIn(token = 'cheto_ut_person') {
    await saveUserCredential(CHETO, token);
    await saveSession({ url: CHETO, userUrl: CHETO, user: 'Ana' });
}

/** The requests that are not identity or lookup reads. */
const writes = () => calls.filter((call) => !['/api/v1/agent/me', '/api/v1/cli/me', '/api/v1/cli/agents'].includes(call.pathname));
const last = () => calls.at(-1);
const shape = (call) => [call.method, call.path, call.body];

beforeEach(() => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(join(CONFIG_DIR, 'session.json'), '{}');
    writeFileSync(SECRETS, '{}');
    delete process.env.CHETO_AGENT;
    delete process.env.CHETO_WORKSPACE;

    calls = [];
    output = [];
    answer = defaultAnswer;
    stubFetch();
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => output.push(args.join(' '));
});

afterEach(() => {
    globalThis.fetch = original.fetch;
    console.log = original.log;
    console.error = original.error;
});

describe('an agent, new verbs', () => {
    beforeEach(() => pair('rocky'));

    it('task delete', async () => {
        assert.equal(await agent.taskDelete(['12', '--agent', 'rocky']), 0);
        assert.deepEqual(shape(last()), ['DELETE', '/api/v1/agent/tasks/12', undefined]);
    });

    it('task update --assignee @handle and --due', async () => {
        assert.equal(await agent.taskUpdate(['12', '--assignee', '@ana', '--due', '2026-10-01', '--agent', 'rocky']), 0);
        assert.deepEqual(shape(writes()[0]), ['PATCH', '/api/v1/agent/tasks/12', { due_on: '2026-10-01', assignee_type: 'user', assignee_id: 3 }]);
    });

    it('task update --assignee none unassigns, alone', async () => {
        assert.equal(await agent.taskUpdate(['12', '--assignee', 'none', '--agent', 'rocky']), 0);
        assert.deepEqual(last().body, { assignee_type: null, assignee_id: null });
    });

    it('task update --points sizes the work, and --points none clears it', async () => {
        assert.equal(await agent.taskUpdate(['12', '--points', '5', '--agent', 'rocky']), 0);
        assert.deepEqual(last().body, { story_points: 5 });

        assert.equal(await agent.taskUpdate(['12', '--points', 'none', '--agent', 'rocky']), 0);
        assert.deepEqual(last().body, { story_points: null });
    });

    it('task update --points with something that is not a number changes nothing', async () => {
        const before = calls.length;

        assert.equal(await agent.taskUpdate(['12', '--points', 'abc', '--agent', 'rocky']), 1);
        assert.equal(calls.filter((call) => call.method === 'PATCH').length, calls.slice(0, before).filter((call) => call.method === 'PATCH').length);
        assert.match(output.join('\n'), /whole number/);
    });

    it('memory update, with --key none clearing the key', async () => {
        assert.equal(await agent.memoryUpdate(['4', '--body', 'new', '--key', 'none', '--agent', 'rocky']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/agent/memory/4', { body: 'new', key: null }]);
    });

    it('status prints the capabilities from /me', async () => {
        answer = (call) => (call.pathname.endsWith('/inbox') ? { body: { summary: { review_requests: 0, assigned_tasks: 0, mentions: 0 } } } : defaultAnswer(call));

        assert.equal(await status(['--agent', 'rocky']), 0);
        assert.match(output.join('\n'), /Can: +tasks\.create, boards\.manage/);
    });
});

describe('boards: which surface speaks', () => {
    it('--agent goes to the agent surface, with no workspace in the body', async () => {
        await pair('rocky');
        await signIn();

        assert.equal(await work.areaCreate(['Reels', '--column', 'Ideas:inbox', '--agent', 'rocky']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/agent/areas', { name: 'Reels', columns: [{ name: 'Ideas', category: 'inbox' }] }]);
        assert.equal(last().headers.Authorization, 'Bearer cheto_ak_rocky');
    });

    it('CHETO_AGENT with a login delegates: person token plus X-Cheto-Agent', async () => {
        await signIn();
        process.env.CHETO_AGENT = 'magui.b2c4@cheto';

        assert.equal(await work.columnAdd(['16', 'Blocked', 'in_progress']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/agent/areas/16/columns', { name: 'Blocked', category: 'in_progress' }]);
        assert.equal(last().headers.Authorization, 'Bearer cheto_ut_person');
        assert.equal(last().headers['X-Cheto-Agent'], 'magui.b2c4@cheto');
    });

    it('signed in and no agent named: you, on /api/v1/cli, even with an agent paired', async () => {
        await pair('rocky');
        await signIn();

        assert.equal(await work.areaCreate(['Reels', '--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/cli/areas', { workspace: 'demo', name: 'Reels' }]);
        assert.equal(await work.boardSurface([]), 'user');
    });

    it('not signed in, one agent paired: that agent', async () => {
        await pair('rocky');

        assert.equal(await work.boardSurface([]), 'agent');

        assert.equal(await work.areaUpdate(['marketing', '--name', 'Mkt']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/agent/areas/marketing', { name: 'Mkt' }]);

        assert.equal(await work.columnUpdate(['16', '77', '--name', 'Ideas']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/agent/areas/16/columns/77', { name: 'Ideas' }]);

        assert.equal(await work.columnReorder(['16', '77', '78']), 0);
        assert.deepEqual(shape(last()), ['PUT', '/api/v1/agent/areas/16/columns', { order: [77, 78] }]);

        assert.equal(await work.columnRemove(['16', '78', '--into', '77']), 0);
        assert.deepEqual(shape(last()), ['DELETE', '/api/v1/agent/areas/16/columns/78', { into: 77 }]);
    });

    it('area list as an agent reads the boards from /me', async () => {
        await pair('rocky');

        assert.equal(await work.areaList(['--agent', 'rocky']), 0);
        assert.deepEqual(calls.map((call) => call.path), ['/api/v1/agent/me']);
        assert.match(output.join('\n'), /Marketing {2}\(marketing\) {2}· {2}area 16\n/);
    });

    it('nothing signed in and nothing paired: refuses without a request', async () => {
        assert.equal(await work.areaCreate(['Reels', '--workspace', 'demo']), 1);
        assert.equal(calls.length, 0);
        assert.match(output.join('\n'), /cheto login/);
    });
});

describe('the person, the rest of the work', () => {
    beforeEach(() => signIn());

    it('user task show and comment', async () => {
        answer = (call) => (call.method === 'GET' ? { body: { data: { id: 12, key: 'T-12', title: 'x', comments: [{ author: { name: 'Ana' }, body: 'ok' }] } } } : defaultAnswer(call));

        assert.equal(await collab.userTaskShow(['12']), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/tasks/12', undefined]);
        assert.match(output.join('\n'), /T-12/);

        assert.equal(await collab.userTaskComment(['12', 'looks', 'good']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/cli/tasks/12/comments', { body: 'looks good' }]);
        assert.equal(last().headers.Authorization, 'Bearer cheto_ut_person');
    });

    it('user task assign: own agent by handle in the workspace, me, typed ids, none', async () => {
        assert.equal(await collab.userTaskAssign(['12', '@magui', '--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/cli/tasks/12', { assignee_type: 'agent', assignee_id: 9 }]);

        assert.equal(await collab.userTaskAssign(['12', 'me']), 0);
        assert.deepEqual(last().body, { assignee_type: 'user', assignee_id: 3 });

        assert.equal(await collab.userTaskAssign(['12', 'user:44']), 0);
        assert.deepEqual(last().body, { assignee_type: 'user', assignee_id: 44 });

        assert.equal(await collab.userTaskAssign(['12', 'none']), 0);
        assert.deepEqual(last().body, { assignee_type: null, assignee_id: null });
    });

    it('user task assign does not pick a same-named agent from another workspace', async () => {
        assert.equal(await collab.userTaskAssign(['12', '@rocky', '--workspace', 'demo']), 1);
        assert.equal(writes().length, 0);
        assert.match(output.join('\n'), /user:<id>/);
    });

    it('user task update --assignee and --due', async () => {
        assert.equal(await work.userTaskUpdate(['12', '--workspace', 'demo', '--due', 'none', '--assignee', 'agent:9']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/cli/tasks/12', { due_on: null, assignee_type: 'agent', assignee_id: 9 }]);
    });

    it('user review list, request, answer', async () => {
        assert.equal(await collab.userReviewList(['--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/reviews?workspace=demo', undefined]);

        assert.equal(await collab.userReviewList([]), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/reviews', undefined]);

        assert.equal(await collab.userReviewRequest(['12', '@magui', '--workspace', 'demo', '--note', 'copy']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/cli/tasks/12/reviews', { reviewer_type: 'agent', reviewer_id: 9, note: 'copy' }]);

        assert.equal(await collab.userReviewAnswer(['5', 'approved', '--note', 'ok']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/cli/reviews/5', { status: 'approved', note: 'ok' }]);
    });

    it('user inbox', async () => {
        process.env.CHETO_WORKSPACE = 'demo';

        assert.equal(await collab.userInbox([]), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/inbox?workspace=demo', undefined]);
        assert.match(output.join('\n'), /2 unread/);
    });

    it('user channel list, read and post resolve a slug to its id in the workspace', async () => {
        assert.equal(await collab.userChannelList(['--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/channels?workspace=demo', undefined]);

        assert.equal(await collab.userChannelRead(['#general', '--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/channels/5/context', undefined]);
        assert.match(output.join('\n'), /Ana: hola/);

        assert.equal(await collab.userChannelPost(['general', 'hola', '@magui', '--workspace', 'demo']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/cli/channels/5/messages', { body: 'hola @magui' }]);

        calls = [];
        assert.equal(await collab.userChannelPost(['5', 'by id']), 0);
        assert.deepEqual(calls.map(shape), [['POST', '/api/v1/cli/channels/5/messages', { body: 'by id' }]]);
    });

    it('user memory list, write, update, forget', async () => {
        answer = (call) => (call.method === 'GET' ? { body: { data: [] } } : defaultAnswer(call));

        assert.equal(await collab.userMemoryList(['--workspace', 'demo', '--q', 'staging']), 0);
        assert.deepEqual(shape(last()), ['GET', '/api/v1/cli/memory?workspace=demo&q=staging', undefined]);

        assert.equal(await collab.userMemoryWrite(['Staging', 'ssh deploy@x', '--workspace', 'demo', '--key', 'staging-access']), 0);
        assert.deepEqual(shape(last()), ['POST', '/api/v1/cli/memory', { workspace: 'demo', title: 'Staging', body: 'ssh deploy@x', key: 'staging-access' }]);

        assert.equal(await collab.userMemoryUpdate(['4', '--title', 'Staging box']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/cli/memory/4', { title: 'Staging box' }]);

        assert.equal(await collab.userMemoryForget(['4']), 0);
        assert.deepEqual(shape(last()), ['DELETE', '/api/v1/cli/memory/4', undefined]);
    });

    it('user search', async () => {
        assert.equal(await collab.userSearch(['deploy', '--workspace', 'demo', '--kind', 'task', '--kind', 'memory', '--limit', '5']), 0);

        const url = new URL(last().url);

        assert.equal(url.pathname, '/api/v1/cli/search');
        assert.equal(url.searchParams.get('workspace'), 'demo');
        assert.equal(url.searchParams.get('q'), 'deploy');
        assert.deepEqual(url.searchParams.getAll('kind[]'), ['task', 'memory']);
        assert.equal(url.searchParams.get('limit'), '5');
    });

    it('workspace-bound reads refuse without one, before any request', async () => {
        assert.equal(await collab.userChannelList([]), 1);
        assert.equal(await collab.userMemoryWrite(['a', 'b']), 1);
        assert.equal(await collab.userSearch(['x']), 1);
        assert.equal(calls.length, 0);
    });

    it('a 403 missing scope says to log in again or edit the token, and keeps the login', async () => {
        answer = () => ({ status: 403, body: { message: 'This credential was not granted that.' } });

        assert.equal(await collab.userChannelList(['--workspace', 'demo']), 1);
        assert.match(output.join('\n'), /cheto login again \(new permissions\) or edit this token in the panel/);
        assert.equal(JSON.parse(readFileSync(SECRETS, 'utf8'))[`${CHETO}#user`], 'cheto_ut_person');
    });

    it('a 403 that is a policy refusal gets no scope hint', async () => {
        answer = () => ({ status: 403, body: { message: 'This action is unauthorized.' } });

        assert.equal(await collab.userMemoryForget(['4']), 1);
        assert.doesNotMatch(output.join('\n'), /new permissions/);
    });
});

describe('agent capabilities, set by the owner', () => {
    it('parses a list, none and default, and refuses unknown names', () => {
        assert.equal(human.capabilitiesFlag(['--name', 'x']), undefined);
        assert.deepEqual(human.capabilitiesFlag(['--capabilities', 'tasks.create, channels.post,tasks.create']), ['tasks.create', 'channels.post']);
        assert.deepEqual(human.capabilitiesFlag(['--capabilities', 'none']), []);
        assert.equal(human.capabilitiesFlag(['--capabilities', 'default']), null);
        assert.throws(() => human.capabilitiesFlag(['--capabilities', 'tasks.close']), /Unknown capability: tasks\.close/);
        assert.throws(() => human.capabilitiesFlag(['--capabilities']), /comma list/);
    });

    it('agent update --capabilities sends the list with the workspace', async () => {
        await signIn();
        answer = () => ({ body: { agent: { name: 'Rocky', slug: 'rocky' }, membership: { mention: '@rocky', workspace: { slug: 'demo' }, capabilities: ['tasks.create'] } } });

        assert.equal(await human.agentUpdate(['4', '--workspace', 'demo', '--capabilities', 'tasks.create']), 0);
        assert.deepEqual(shape(last()), ['PATCH', '/api/v1/cli/agents/4', { workspace: 'demo', capabilities: ['tasks.create'] }]);

        assert.equal(await human.agentUpdate(['4', '--workspace', 'demo', '--capabilities', 'default']), 0);
        assert.deepEqual(last().body, { workspace: 'demo', capabilities: null });
    });

    it('agent update --capabilities without --workspace refuses before any request', async () => {
        await signIn();

        assert.equal(await human.agentUpdate(['4', '--capabilities', 'tasks.create']), 1);
        assert.equal(calls.length, 0);
    });
});
