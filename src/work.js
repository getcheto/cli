/**
 * Boards, columns and tasks, as the person — not as an agent.
 *
 * The human half of the MCP server's tool set (`@getcheto/mcp`, human tools),
 * on the person's own login from `cheto login` and the `/api/v1/cli` surface.
 *
 *   - Boards and columns (`cheto area …`, `cheto column …`) are the one place
 *     both principals share a verb, so which one speaks is decided by a rule
 *     (`boardSurface`): `--agent`/`CHETO_AGENT` given → that agent, on
 *     `/api/v1/agent/areas` (needs its `boards.manage` capability); otherwise
 *     your login when you are signed in; otherwise the agent paired here.
 *   - Tasks are the one noun both principals act on, so the person's verbs sit
 *     under `cheto user task …`. `cheto task …` is always an agent speaking;
 *     `cheto user task …` is always you. A task filed there is created by you,
 *     and a backlog somebody else wrote can be triaged there — which the agent
 *     surface refuses by design.
 *
 * The workspace comes from `--workspace`, or `CHETO_WORKSPACE` (the same
 * variable the MCP reads). `cheto whoami` lists the ones your login reaches.
 */

import { ChetoError } from './api.js';
import { isNobody, taskRef } from './agent-commands.js';
import { apiFor } from './clients.js';
import { agentFlag, flag, flags, positionals, requireSession } from './cli.js';
import { listAgentSessions, loadUserSession } from './credentials.js';
import { requireUser } from './human.js';

const log = (...args) => console.log(...args);
const warn = (...args) => console.error(...args);

const CATEGORIES = ['inbox', 'ready', 'in_progress', 'review', 'done'];

// ── Boards ─────────────────────────────────────────────

/** `cheto area list --workspace <slug>` — boards and their columns, with the ids the other commands take. */
export async function areaList(args = []) {
    return withBoard(args, async (api, as) => {
        let answer;

        if (as === 'agent') {
            // The agent surface lists its boards on the identity call.
            answer = { data: await api.areas() };
        } else {
            const query = new URLSearchParams({ workspace: workspaceOf(args) });

            if (args.includes('--archived')) {
                query.set('archived', '1');
            }

            answer = await api.areas(query);
        }

        if (args.includes('--json')) {
            log(JSON.stringify(answer, null, 2));

            return 0;
        }

        log('');
        (answer.data ?? []).forEach((area) => {
            log(`  ${[`${area.name}  (${area.slug})`, `area ${area.id}`, area.uuid].filter(Boolean).join('  ·  ')}`);
            log(`    ${(area.statuses ?? []).map((column) => `${column.name} [${column.id}, ${categoryOf(column)}]`).join('  ·  ')}`);
        });
        log('');

        return 0;
    });
}

/**
 * `cheto area create "Name" --workspace <slug> [--column "Name:category"]…`
 *
 * Each column says what it means — one of inbox, ready, in_progress, review,
 * done — because the words are the team's and the meaning is what every rule
 * in Cheto reads. Without `--column` the board gets the five defaults.
 */
export async function areaCreate(args = []) {
    const [name] = positionals(args);

    if (!name) {
        warn('Usage: cheto area create "Name" [--workspace <slug>] [--description "…"] [--color] [--icon]');
        warn('       --workspace is needed as you; an agent (--agent) is already in one.');
        warn(`                         [--column "Name:<${CATEGORIES.join('|')}>"]...  (left to right)`);

        return 1;
    }

    let columns;

    try {
        columns = flags(args, '--column').map(parseColumn);
    } catch (error) {
        warn(error.message);

        return 1;
    }

    return withBoard(args, async (api, as) => {
        const body = {
            // An agent is in exactly one workspace; the person names one.
            ...(as === 'user' ? { workspace: workspaceOf(args) } : {}),
            name,
            ...optional('description', flag(args, '--description')),
            ...optional('color', flag(args, '--color')),
            ...optional('icon', flag(args, '--icon')),
            ...(columns.length > 0 ? { columns } : {}),
        };

        const answer = await api.createArea(body, `cheto-area-${slug(name)}`);
        const area = answer.data ?? answer.area ?? answer;

        log(`Created board ${area.name ?? name}${area.id ? `  ·  area ${area.id}` : ''}.`);

        return 0;
    });
}

/** `cheto area update <uuid|id> [--name] [--description] [--color] [--icon]` */
export async function areaUpdate(args = []) {
    const [area] = positionals(args);
    const body = {
        ...optional('name', flag(args, '--name')),
        ...optional('description', flag(args, '--description')),
        ...optional('color', flag(args, '--color')),
        ...optional('icon', flag(args, '--icon')),
    };

    if (!area || Object.keys(body).length === 0) {
        warn('Usage: cheto area update <area-uuid|id> [--name "…"] [--description "…"] [--color] [--icon]');

        return 1;
    }

    return withBoard(args, async (api) => {
        await api.updateArea(area, body);

        log(`Updated board ${area}.`);

        return 0;
    });
}

// ── Columns ────────────────────────────────────────────

/** `cheto column add <area> "Name" <category>` */
export async function columnAdd(args = []) {
    const [area, name, category] = positionals(args);

    if (!area || !name || !CATEGORIES.includes(String(category))) {
        warn(`Usage: cheto column add <area-uuid|id> "Name" <${CATEGORIES.join('|')}>`);

        return 1;
    }

    return withBoard(args, async (api) => {
        await api.addColumn(area, { name, category });

        log(`Added "${name}" (${category}) to board ${area}.`);

        return 0;
    });
}

/** `cheto column update <area> <column-id> [--name "…"] [--category …]` — a new category moves every task in it. */
export async function columnUpdate(args = []) {
    const [area, column] = positionals(args);
    const name = flag(args, '--name');
    const category = flag(args, '--category');
    const body = { ...(name !== null ? { name } : {}), ...optional('category', category) };

    if (!area || !column || Object.keys(body).length === 0 || (category && !CATEGORIES.includes(category))) {
        warn(`Usage: cheto column update <area-uuid|id> <column-id> [--name "…"] [--category ${CATEGORIES.join('|')}]`);

        return 1;
    }

    return withBoard(args, async (api) => {
        await api.updateColumn(area, column, body);

        log(`Updated column ${column}.`);

        return 0;
    });
}

/** `cheto column reorder <area> <column-id> <column-id> …` — left to right. */
export async function columnReorder(args = []) {
    const [area, ...order] = positionals(args);

    if (!area || order.length === 0 || order.some((id) => !/^\d+$/.test(id))) {
        warn('Usage: cheto column reorder <area-uuid|id> <column-id> <column-id> ...   (left to right)');

        return 1;
    }

    return withBoard(args, async (api) => {
        await api.reorderColumns(area, order.map(Number));

        log(`Reordered the columns of board ${area}.`);

        return 0;
    });
}

/** `cheto column remove <area> <column-id> --into <column-id>` — its tasks move, never vanish. */
export async function columnRemove(args = []) {
    const [area, column] = positionals(args);
    const into = flag(args, '--into');

    if (!area || !column || !into) {
        warn('Usage: cheto column remove <area-uuid|id> <column-id> --into <column-id>');
        warn('--into is required: the work in it has to go somewhere somebody chose.');

        return 1;
    }

    return withBoard(args, async (api) => {
        await api.removeColumn(area, column, Number(into));

        log(`Removed column ${column}; its tasks are in column ${into}.`);

        return 0;
    });
}

// ── Tasks, as you ──────────────────────────────────────

/** `cheto user task list --workspace <slug> [--area …] [--open]` */
export async function userTaskList(args = []) {
    return withUser(args, async (api) => {
        const workspace = workspaceOf(args);
        const query = new URLSearchParams({ workspace });
        const area = flag(args, '--area');

        if (area) {
            query.set('area', String((await boardIn(api, workspace, area)).id));
        }

        if (args.includes('--open')) {
            query.set('open', '1');
        }

        const answer = await api.tasks(query);

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        const rows = Array.isArray(answer?.data) ? answer.data : [];

        if (rows.length === 0) {
            log('No tasks here.');

            return 0;
        }

        log('');
        rows.forEach((task) => {
            log(`  ${String(task.id).padEnd(6)} ${String(task.key ?? '').padEnd(10)} ${String(task.status?.value ?? task.status ?? '').padEnd(12)} ${task.title}`);
        });
        log('');

        return 0;
    });
}

/** `cheto user task create "Title" --workspace <slug> [--area] [--column] …` — filed by you, not by a machine. */
export async function userTaskCreate(args = []) {
    const [title] = positionals(args);

    if (!title) {
        warn('Usage: cheto user task create "Title" --workspace <slug> [--area <name|slug|id>] [--column "Name"]');
        warn('                              [--description] [--type] [--priority] [--status] [--due] [--tag]...');
        warn('                              [--requires-human]');

        return 1;
    }

    return withUser(args, async (api) => {
        const workspace = workspaceOf(args);
        const placement = await placementIn(api, workspace, flag(args, '--area'), flag(args, '--column'));
        const body = { workspace, title, ...describing(args), ...optional('status', flag(args, '--status')), ...placement };

        const answer = await api.createTask(body, `cheto-user-task-${slug(title)}`);
        const task = answer.data ?? answer;

        log(`${task.key ?? ''}  ${task.title ?? title}`.trim());

        return 0;
    });
}

/** `cheto user task update <id> --workspace <slug> [--column "Name"] [--title] …` — triage, as yourself. */
export async function userTaskUpdate(args = []) {
    const [id] = positionals(args);
    const body = { ...describing(args), ...optional('status', flag(args, '--status')) };
    const column = flag(args, '--column');
    const assignee = flag(args, '--assignee');

    if (!id || (Object.keys(body).length === 0 && !column && assignee === null)) {
        warn('Usage: cheto user task update <task-id> --workspace <slug> [--column "Name" [--area …]] [--status]');
        warn('                                        [--title] [--description] [--type] [--priority] [--due YYYY-MM-DD|none]');
        warn('                                        [--assignee me|@agent|user:<id>|agent:<id>|none]');
        warn('                                        [--tag]... (replaces every tag) [--requires-human|--no-requires-human]');

        return 1;
    }

    return withUser(args, async (api) => {
        const task = taskRef(id);

        if (column) {
            const workspace = workspaceOf(args);
            const placement = await columnIn(api, workspace, flag(args, '--area'), column);

            // The column wins over a status: two names for one move is two
            // chances to disagree.
            delete body.status;
            Object.assign(body, placement);
        }

        if (assignee !== null) {
            Object.assign(body, await actorFields(api, args, assignee, 'assignee'));
        }

        const answer = await api.updateTask(task, body, `cheto-user-update-${task}-${slug(JSON.stringify(body))}`);

        log(`Updated ${answer?.data?.key ?? `task ${task}`}.`);

        return 0;
    });
}

/** `cheto user task delete <id>` — off the board for good (a soft delete). An agent needs `tasks.delete` for the same. */
export async function userTaskDelete(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto user task delete <task-id>');

        return 1;
    }

    return withUser(args, async (api) => {
        const task = taskRef(id);

        await api.deleteTask(task);

        log(`Deleted task ${task}. The activity trail still names it; this API does not bring it back.`);

        return 0;
    });
}

/**
 * `cheto agent token <membership> --name "what it is for" [--expires-days N]`
 *
 * A raw agent credential for a machine with nowhere to type `cheto connect` —
 * a container, a cron line, an MCP entry's env block. Printed once, because
 * that is the only time it exists outside Cheto. Prefer `cheto agent pair`
 * wherever there is a terminal.
 */
export async function agentToken(args = []) {
    const [membership] = positionals(args);
    const name = flag(args, '--name');

    if (!membership || !name) {
        warn('Usage: cheto agent token <membership-id> --name "what holds it" [--expires-days 90]');
        warn('Shown once. Prefer cheto agent pair where the machine has a terminal.');

        return 1;
    }

    return withUser(args, async (api) => {
        const days = flag(args, '--expires-days');
        const issued = await api.issueCredential(membership, { name, ...(days ? { expires_in_days: Number(days) } : {}) });

        log('');
        log(`  A credential for ${issued.membership?.mention ?? `membership ${membership}`} in ${issued.membership?.workspace?.slug ?? '?'}:`);
        log('');
        log(`    ${issued.token}`);
        log('');
        log(`  Shown once. Expires: ${issued.expires_at ?? 'never'}. Revoke it from the Agents page.`);
        log('');

        return 0;
    });
}

// ── Shared ────────────────────────────────────────────

/**
 * Who reshapes a board: `'agent'` or `'user'`.
 *
 *   1. `--agent` or `CHETO_AGENT` names an agent → that agent.
 *   2. Signed in with `cheto login` → you.
 *   3. Not signed in, but an agent is paired here → that agent.
 *
 * Explicit beats implicit, and a person signed in is never silently turned
 * into one of their agents: the audit trail would name the wrong actor.
 */
export async function boardSurface(args = []) {
    if (agentFlag(args)) {
        return 'agent';
    }

    if (await loadUserSession()) {
        return 'user';
    }

    return (await listAgentSessions()).length > 0 ? 'agent' : 'user';
}

async function withBoard(args, work) {
    if ((await boardSurface(args)) === 'user') {
        return withUser(args, (api) => work(api, 'user'));
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    try {
        return (await work(apiFor(session), 'agent')) ?? 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

async function withUser(args, work) {
    const api = await requireUser();

    if (!api) {
        return 1;
    }

    try {
        return (await work(api)) ?? 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

export function workspaceOf(args) {
    const workspace = flag(args, '--workspace') ?? process.env.CHETO_WORKSPACE ?? null;

    if (!workspace || String(workspace).trim() === '') {
        throw new ChetoError('Say which workspace: --workspace <slug|uuid>, or set CHETO_WORKSPACE. cheto whoami lists them.');
    }

    return String(workspace).trim();
}

/** What a task says about itself, from flags. Shared by create and update. */
export function describing(args) {
    const body = {
        ...optional('title', flag(args, '--title')),
        ...optional('description', flag(args, '--description')),
        ...optional('type', flag(args, '--type')),
        ...optional('priority', flag(args, '--priority')),
    };

    const due = flag(args, '--due');

    if (due !== null) {
        body.due_on = ['none', 'null'].includes(due.toLowerCase()) ? null : due;
    }

    const points = flag(args, '--points');

    if (points !== null) {
        body.story_points = ['none', 'null'].includes(points.toLowerCase()) ? null : Number(points);
    }

    const tags = flags(args, '--tag');

    if (tags.length > 0) {
        body.tags = tags;
    }

    if (args.includes('--requires-human')) {
        body.requires_human = true;
    } else if (args.includes('--no-requires-human')) {
        body.requires_human = false;
    }

    return body;
}

/**
 * Somebody, named by the person, as the `{<prefix>_type, <prefix>_id}` pair the API takes.
 *
 *   none              nobody (only for an assignee)
 *   me                you
 *   user:12 agent:9   by id, for anybody in the workspace
 *   @rocky            one of YOUR agents, by its handle in --workspace (or its address)
 *
 * The person's surface has no participant list, so a colleague is named by
 * id; the server still checks they are in the task's workspace.
 */
export async function actorFields(api, args, who, prefix) {
    const wanted = String(who).trim();

    if (isNobody(wanted)) {
        if (prefix !== 'assignee') {
            throw new ChetoError(`A ${prefix} has to be somebody.`);
        }

        return { [`${prefix}_type`]: null, [`${prefix}_id`]: null };
    }

    const typed = /^(user|agent):(\d+)$/i.exec(wanted);

    if (typed) {
        return { [`${prefix}_type`]: typed[1].toLowerCase(), [`${prefix}_id`]: Number(typed[2]) };
    }

    if (wanted.toLowerCase() === 'me') {
        const { user } = await api.me();

        return { [`${prefix}_type`]: 'user', [`${prefix}_id`]: user.id };
    }

    const workspace = workspaceOf(args);
    const handle = wanted.replace(/^@/, '').toLowerCase();
    const { data: agents = [] } = await api.agents();

    for (const agent of agents) {
        if (String(agent.address ?? '').toLowerCase() === handle && (agent.memberships ?? []).length > 0) {
            return { [`${prefix}_type`]: 'agent', [`${prefix}_id`]: agent.id };
        }

        const here = (agent.memberships ?? []).find(
            (membership) =>
                String(membership.handle ?? '').toLowerCase() === handle &&
                [membership.workspace?.slug, membership.workspace?.uuid].some((one) => String(one ?? '').toLowerCase() === workspace.toLowerCase()),
        );

        if (here) {
            return { [`${prefix}_type`]: 'agent', [`${prefix}_id`]: agent.id };
        }
    }

    throw new ChetoError(`None of your agents answers to "${who}" in ${workspace}. Name a colleague as user:<id> or agent:<id>, yourself as me.`);
}

function parseColumn(value) {
    const at = String(value).lastIndexOf(':');
    const name = at === -1 ? '' : value.slice(0, at).trim();
    const category = at === -1 ? '' : value.slice(at + 1).trim();

    if (!name || !CATEGORIES.includes(category)) {
        throw new ChetoError(`--column "${value}" needs a name and what it means: "Name:<${CATEGORIES.join('|')}>".`);
    }

    return { name, category };
}

async function boardIn(api, workspace, area) {
    const { data: areas = [] } = await api.areas(new URLSearchParams({ workspace }));
    const wanted = String(area).trim().toLowerCase();

    const board =
        areas.find((candidate) => String(candidate.id) === wanted) ??
        areas.find((candidate) => String(candidate.uuid ?? '').toLowerCase() === wanted) ??
        areas.find((candidate) => String(candidate.slug ?? '').toLowerCase() === wanted) ??
        areas.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!board) {
        throw new ChetoError(`"${workspace}" has no board called "${area}". It has: ${areas.map((one) => `${one.name} (${one.slug})`).join(', ') || 'none'}.`);
    }

    return board;
}

/** A board and optionally a column, as the fields the API takes. A name not found fails; it never falls back. */
async function placementIn(api, workspace, area, column) {
    if (!area) {
        if (column) {
            throw new ChetoError('A column belongs to a board, so --column needs --area as well. cheto area list shows both.');
        }

        return {};
    }

    const board = await boardIn(api, workspace, area);

    if (!column) {
        return { work_area_id: board.id };
    }

    return { work_area_status_id: columnOf(board, column).id };
}

/**
 * A column named for a move, across every board unless `--area` narrows it.
 * An ambiguous name fails with the boards that matched, rather than picking one.
 */
async function columnIn(api, workspace, area, column) {
    if (area) {
        return { work_area_status_id: columnOf(await boardIn(api, workspace, area), column).id };
    }

    const { data: areas = [] } = await api.areas(new URLSearchParams({ workspace }));
    const wanted = String(column).trim().toLowerCase();
    const matches = areas.flatMap((board) =>
        (board.statuses ?? [])
            .filter((one) => [one.id, one.name, one.key].some((field) => String(field ?? '').toLowerCase() === wanted))
            .map((one) => ({ board, column: one })),
    );

    if (matches.length === 0) {
        throw new ChetoError(`No column called "${column}" in ${workspace}. cheto area list shows them.`);
    }

    if (matches.length > 1) {
        throw new ChetoError(`"${column}" is a column on ${matches.length} boards — ${matches.map((one) => one.board.name).join(', ')}. Say which with --area.`);
    }

    return { work_area_status_id: matches[0].column.id };
}

function columnOf(board, column) {
    const wanted = String(column).trim().toLowerCase();
    const match = (board.statuses ?? []).find((one) => [one.id, one.name, one.key].some((field) => String(field ?? '').toLowerCase() === wanted));

    if (!match) {
        throw new ChetoError(`"${board.name}" has no column called "${column}". It has: ${(board.statuses ?? []).map((one) => one.name).join(', ')}.`);
    }

    return match;
}

function categoryOf(column) {
    const category = column?.category;

    return typeof category === 'string' ? category : (category?.value ?? column?.key ?? '?');
}

function optional(field, value) {
    return value ? { [field]: value } : {};
}

function slug(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}
