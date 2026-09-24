/**
 * The rest of what an agent may do, as commands.
 *
 * The same set the MCP server (`@getcheto/mcp`) offers as tools, so an agent
 * living in a shell and one living behind MCP can do the same things: list and
 * read work, claim it, hand it on, change what it says about itself, ask for
 * and answer reviews, talk in channels, say it is still here. Each one is a
 * thin call over the API client — the rules (an agent never closes its own
 * work, never touches a task it neither wrote nor holds) are the server's.
 *
 * Every command here acts as one specific agent, chosen exactly as the rest of
 * `cli.js` chooses one: a credential paired here, or the person's login plus
 * `--agent <address>`. See `requireSession`.
 */

import { ChetoError } from './api.js';
import { apiFor } from './clients.js';
import { flag, flags, positionals, requireSession } from './cli.js';

const log = (...args) => console.log(...args);
const warn = (...args) => console.error(...args);

const STATUSES = ['inbox', 'ready', 'in_progress', 'review', 'done'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TYPES = ['task', 'feature', 'bug', 'chore', 'epic', 'idea'];

/**
 * `cheto task list` — the work, filtered.
 *
 *   cheto task list --assigned me            what this agent holds, review included
 *   cheto task list --area marketing --all   one board, finished work too
 *   cheto task list --tag reel --tag urgent  carrying ALL of those tags
 */
export async function taskList(args = []) {
    return withAgent(args, async (api) => {
        const query = new URLSearchParams();
        const area = flag(args, '--area');

        // Named in words here, sent by slug: resolved against what this
        // credential sees, so a wrong name fails with the list of real ones
        // instead of silently listing every board.
        if (area) {
            query.set('area', (await boardFor(api, area)).slug);
        }

        const status = flag(args, '--status');

        if (status && !STATUSES.includes(status)) {
            throw new ChetoError(`--status is one of ${STATUSES.join(', ')}.`);
        }

        setIf(query, 'status', status);
        setIf(query, 'assigned', flag(args, '--assigned'));
        setIf(query, 'limit', flag(args, '--limit'));
        setIf(query, 'cursor', flag(args, '--cursor'));
        setIf(query, 'created_after', flag(args, '--since'));

        if (args.includes('--all')) {
            query.set('open', 'false');
        } else if (args.includes('--open')) {
            query.set('open', 'true');
        }

        if (args.includes('--count')) {
            query.set('count', 'true');
        }

        // Repeated rather than joined: a comma-joined value would be one tag
        // with a comma in its name.
        flags(args, '--tag').forEach((tag) => query.append('tag[]', tag));

        const answer = await api.tasks(query);

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        const rows = Array.isArray(answer?.data) ? answer.data : [];

        if (rows.length === 0) {
            log('No tasks match.');

            return 0;
        }

        log('');
        rows.forEach((task) => {
            const holder = task.assignee ? `${task.assignee.name} (${task.assignee.type})` : 'nobody';

            log(`  ${String(task.id).padEnd(6)} ${String(task.key ?? '').padEnd(10)} ${String(task.status?.value ?? '').padEnd(12)} ${task.title}`);
            log(`         ${task.board_status?.name ?? ''}${task.board_status ? '  ·  ' : ''}${holder}`);
        });

        const next = answer.next_cursor ?? answer.meta?.next_cursor ?? null;

        log('');

        if (answer.total !== undefined || answer.meta?.total !== undefined) {
            log(`  ${answer.total ?? answer.meta.total} matching`);
        }

        if (next) {
            log(`  More: cheto task list --cursor ${next}`);
        }

        log('');

        return 0;
    });
}

/** `cheto task show <id>` — one task in full, with its comments and reviews. */
export async function taskShow(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto task show <task-id> [--json]');

        return 1;
    }

    return withAgent(args, async (api) => {
        const { data: task } = await api.task(taskRef(id));

        printTask(task, args);

        return 0;
    });
}

/**
 * One task in full, as a person reads it. Shared by `cheto task show` and
 * `cheto user task show`: the same resource comes back on both surfaces.
 */
export function printTask(task, args = []) {
    if (args.includes('--json')) {
        log(JSON.stringify(task));

        return;
    }

    log('');
    log(`  ${task.key}  ${task.title}`);
    log(`  Status:      ${task.status?.value}${task.board_status ? `  (${task.board_status.name})` : ''}`);
    log(`  Type:        ${task.type?.value ?? task.type ?? 'task'}   Priority: ${task.priority?.value ?? task.priority ?? 'normal'}`);
    log(`  Assignee:    ${task.assignee ? `${task.assignee.name} (${task.assignee.type})` : 'nobody'}${task.accepted_at ? '' : task.assignee ? '  · not accepted yet' : ''}`);

    if (task.story_points !== null && task.story_points !== undefined) {
        log(`  Points:      ${task.story_points}`);
    }

    if (task.due_on) {
        log(`  Due:         ${task.due_on}`);
    }

    if ((task.tags ?? []).length > 0) {
        log(`  Tags:        ${task.tags.map((tag) => tag.name).join(', ')}`);
    }

    if (task.requires_human) {
        log('  Requires a person before a machine acts on it.');
    }

    if ((task.allowed_transitions ?? []).length > 0) {
        log(`  Can move to: ${task.allowed_transitions.join(', ')}`);
    }

    if (task.description) {
        log('');
        log(task.description);
    }

    (task.reviews ?? []).forEach((review) => {
        const note = review.note ?? review.response_note ?? review.request_note;

        log('');
        log(`  review ${review.id}  ${review.status?.value ?? review.status}  ·  ${review.reviewer?.name ?? '?'}${note ? `: ${note}` : ''}`);
    });

    if ((task.comments ?? []).length > 0) {
        log('');
        log(`  ${task.comments.length} comment${task.comments.length === 1 ? '' : 's'}`);

        task.comments.forEach((comment) => {
            log('');
            log(`  ${comment.author?.name ?? 'somebody'}${comment.created_at ? `  ·  ${String(comment.created_at).slice(0, 16).replace('T', ' ')}` : ''}`);
            log(`    ${String(comment.body ?? '').replace(/\n/g, '\n    ')}`);
        });
    }

    log('');
}

/** `cheto task claim <id>` — take work nobody holds, and start it. */
export async function taskClaim(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto task claim <task-id>');

        return 1;
    }

    return withAgent(args, async (api) => {
        const task = taskRef(id);
        const { data } = await api.claim(task, `cheto-claim-${task}`);

        log(`Claimed ${data?.key ?? `task ${task}`}. It is yours and started.`);

        return 0;
    });
}

/**
 * `cheto task assign <id> <@handle|none>` — offer it to somebody, or to nobody.
 *
 * An offer, not an instruction: the other side still accepts, and nothing
 * starts on their machine because of this.
 */
export async function taskAssign(args = []) {
    const [id, who] = positionals(args);

    if (!id || !who) {
        warn('Usage: cheto task assign <task-id> <@handle|none>');

        return 1;
    }

    return withAgent(args, async (api) => {
        const task = taskRef(id);
        const nobody = isNobody(who);
        const fields = nobody ? { assignee_type: null, assignee_id: null } : await participantFields(api, who, 'assignee');
        const { data } = await api.updateTask(task, fields, `cheto-assign-${task}-${slug(nobody ? 'nobody' : who)}`);

        log(nobody ? `${data?.key ?? `Task ${task}`} is held by nobody now.` : `${data?.key ?? `Task ${task}`} offered to ${data?.assignee?.name ?? who}. They still have to accept.`);

        return 0;
    });
}

/**
 * `cheto task update <id>` — change what a task says about itself.
 *
 * Moving it is `task move`, which knows about columns. `--tag` REPLACES the
 * whole set, the way the API takes it.
 */
export async function taskUpdate(args = []) {
    const [id] = positionals(args);

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

    const assignee = flag(args, '--assignee');

    if (!id || (Object.keys(body).length === 0 && assignee === null)) {
        warn('Usage: cheto task update <task-id> [--title "…"] [--description "…"] [--type bug]');
        warn(`                                    [--priority ${PRIORITIES.join('|')}] [--due 2026-09-30|none]`);
        warn('                                    [--tag a --tag b]  (replaces every tag)');
        warn('                                    [--assignee @handle|none]');
        warn('                                    [--requires-human | --no-requires-human]');

        return 1;
    }

    if (body.type && !TYPES.includes(body.type)) {
        warn(`--type is one of ${TYPES.join(', ')}.`);

        return 1;
    }

    if (body.priority && !PRIORITIES.includes(body.priority)) {
        warn(`--priority is one of ${PRIORITIES.join(', ')}.`);

        return 1;
    }

    return withAgent(args, async (api) => {
        const task = taskRef(id);

        if (assignee !== null) {
            Object.assign(body, isNobody(assignee) ? { assignee_type: null, assignee_id: null } : await participantFields(api, assignee, 'assignee'));
        }

        const { data } = await api.updateTask(task, body, `cheto-update-${task}-${slug(JSON.stringify(body))}`);

        // The one field this Cheto may validate and then not write, when it
        // travels alone. A 200 with the gate still open is not success.
        if ('requires_human' in body && data?.requires_human !== undefined && data.requires_human !== body.requires_human) {
            warn(`The rest went through, but requires_human is still ${data.requires_human}: this Cheto writes it only alongside a descriptive field.`);
            warn('Send it again together with --title, --description, --type, --priority, --due or --tag.');

            return 1;
        }

        log(`Updated ${data?.key ?? `task ${task}`}.`);

        return 0;
    });
}

/**
 * `cheto task delete <id>` — take it off the board (a soft delete).
 *
 * Needs the `tasks.delete` capability on this agent's membership, which the
 * owner can switch off; without it the server answers 403 and says so.
 */
export async function taskDelete(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto task delete <task-id>');

        return 1;
    }

    return withAgent(args, async (api) => {
        const task = taskRef(id);
        const { data } = await api.deleteTask(task);

        log(`Deleted ${data?.key ?? `task ${task}`}. The activity trail still names it; this API does not bring it back.`);

        return 0;
    });
}

/** `cheto memory update <id> [--title] [--body] [--key name|none]` — needs `memory.write`. */
export async function memoryUpdate(args = []) {
    const [id] = positionals(args);
    const body = memoryChanges(args);

    if (!id || Object.keys(body).length === 0) {
        warn('Usage: cheto memory update <memory-id> [--title "…"] [--body "…"] [--key staging-access|none]');

        return 1;
    }

    return withAgent(args, async (api) => {
        const { data } = await api.updateMemory(id, body);

        log(`Updated memory ${data?.id ?? id}${data?.title ? `: ${data.title}` : ''}.`);

        return 0;
    });
}

/** What `memory update` changes, from flags. `--key none` clears the key. Shared with the person's version. */
export function memoryChanges(args) {
    const body = {
        ...optional('title', flag(args, '--title')),
        ...optional('body', flag(args, '--body')),
    };

    const key = flag(args, '--key');

    if (key !== null) {
        body.key = isNobody(key) ? null : key;
    }

    return body;
}

/** `cheto review list` — reviews this agent owes somebody an answer on. */
export async function reviewList(args = []) {
    return withAgent(args, async (api) => {
        const answer = await api.reviews();

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        printReviews(Array.isArray(answer?.data) ? answer.data : [], 'cheto review answer');

        return 0;
    });
}

/** Reviews waiting on somebody, with the command that answers one. */
export function printReviews(rows, answerWith) {
    if (rows.length === 0) {
        log('No reviews waiting on you.');

        return;
    }

    log('');
    rows.forEach((review) => {
        const note = review.note ?? review.request_note;

        log(`  review ${review.id}  ·  ${review.task?.key ?? `task ${review.task_id}`}  ${review.task?.title ?? ''}`.trimEnd());
        log(`    asked by ${review.requested_by?.name ?? review.requester?.name ?? '?'}${note ? `: ${note}` : ''}`);
    });
    log('');
    log(`  Answer one: ${answerWith} <review-id> approved|changes_requested [--note "…"]`);
    log('');
}

/**
 * `cheto review request <task> <@reviewer> [--note]` — ask somebody to look.
 *
 * How work gets finished: an agent cannot close it, a reviewer decides.
 */
export async function reviewRequest(args = []) {
    const [id, who] = positionals(args);

    if (!id || !who) {
        warn('Usage: cheto review request <task-id> <@reviewer> [--note "what to look at"]');

        return 1;
    }

    return withAgent(args, async (api) => {
        const task = taskRef(id);
        const body = { ...(await participantFields(api, who, 'reviewer')), ...optional('note', flag(args, '--note')) };

        await api.requestReview(task, body, `cheto-review-${task}`);

        log(`Asked ${who} to review task ${task}.`);

        return 0;
    });
}

/** `cheto review answer <review> approved|changes_requested [--note]` */
export async function reviewAnswer(args = []) {
    const [id, status] = positionals(args);

    if (!id || !['approved', 'changes_requested'].includes(String(status))) {
        warn('Usage: cheto review answer <review-id> approved|changes_requested [--note "…"]');

        return 1;
    }

    return withAgent(args, async (api) => {
        await api.answerReview(id, { status, ...optional('note', flag(args, '--note')) }, `cheto-answer-${id}`);

        log(`Answered review ${id}: ${status}.`);

        return 0;
    });
}

/** `cheto channel list` — the rooms of this workspace. */
export async function channelList(args = []) {
    return withAgent(args, async (api) => {
        const answer = await api.channels();

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        log('');
        (answer.data ?? []).forEach((channel) => log(`  #${String(channel.slug).padEnd(24)} ${channel.name ?? ''}  ·  channel ${channel.id}`));
        log('');

        return 0;
    });
}

/** `cheto channel read <channel>` — the bounded read: recent summaries, then the messages after them. */
export async function channelRead(args = []) {
    const [channel] = positionals(args);

    if (!channel) {
        warn('Usage: cheto channel read <slug|id> [--json]');

        return 1;
    }

    return withAgent(args, async (api) => {
        const answer = await api.context(encodeURIComponent(channel.replace(/^#/, '')));

        printContext(answer, args);

        return 0;
    });
}

/** The bounded read of a channel: its summaries, then the messages after them. Same shape on both surfaces. */
export function printContext(answer, args = []) {
    if (args.includes('--json')) {
        log(JSON.stringify(answer));

        return;
    }

    log('');

    (answer.compacts ?? []).forEach((compact) => {
        log(`  [summary] ${String(compact.body ?? '').replace(/\s+/g, ' ')}`);
        log('');
    });

    (answer.messages ?? answer.data ?? []).forEach((message) => {
        log(`  ${message.author?.name ?? 'somebody'}: ${message.body}`);
    });

    log('');
}

/** `cheto channel post <channel> <text>` — say something in a room. @handles resolve server-side. */
export async function channelPost(args = []) {
    const [channel, ...rest] = positionals(args);
    const body = rest.join(' ').trim();

    if (!channel || !body) {
        warn('Usage: cheto channel post <slug|id> "what you want to say"');

        return 1;
    }

    return withAgent(args, async (api) => {
        const room = channel.replace(/^#/, '');

        await api.post(encodeURIComponent(room), body, `cheto-post-${slug(room)}-${slug(body)}`);

        log(`Posted in #${room}.`);

        return 0;
    });
}

/** `cheto heartbeat [--status online|busy|offline]` — say this agent is still here. */
export async function heartbeat(args = []) {
    const status = flag(args, '--status');

    if (status && !['online', 'busy', 'offline'].includes(status)) {
        warn('Usage: cheto heartbeat [--status online|busy|offline]');

        return 1;
    }

    return withAgent(args, async (api, session) => {
        await api.heartbeat(status);

        log(`${session.mention ?? `@${session.handle}`} is ${status ?? 'online'}.`);

        return 0;
    });
}

/** `cheto capacity` — the workload by board, as the server derives it. */
export async function capacity(args = []) {
    return withAgent(args, async (api) => {
        const answer = await api.capacity();

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        log('');
        (answer.data ?? answer.areas ?? []).forEach((row) => {
            const name = row.area?.name ?? row.name ?? '?';
            const counts = Object.entries(row.counts ?? row)
                .filter(([, value]) => typeof value === 'number')
                .map(([key, value]) => `${key} ${value}`)
                .join('  ·  ');

            log(`  ${name}`);
            log(`    ${counts}`);
        });
        log('');

        return 0;
    });
}

// ── Shared ────────────────────────────────────────────

async function withAgent(args, work) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    try {
        return (await work(apiFor(session), session)) ?? 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * A task, as the API addresses one: its number.
 *
 * "MKT-12" is the key a card prints and a uuid is what everything else uses; a
 * task takes neither, and saying so beats a 404 that gets retried.
 */
export function taskRef(id) {
    const wanted = String(id ?? '').trim();

    if (/^\d+$/.test(wanted)) {
        return Number(wanted);
    }

    throw new ChetoError(`"${id}" is not a task id. A task is addressed by its number — the id cheto task list prints — never by the key a board shows on the card.`);
}

/**
 * A handle as it is compared: lower case, accents off — "@lucia" is Lucía,
 * the way the server resolves a mention.
 */
function fold(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
}

/**
 * Somebody named by @handle, as the `{<prefix>_type, <prefix>_id}` pair the API takes.
 *
 * Resolved against this workspace's participants only — the boundary the
 * server enforces on the way in — so a handle from another workspace is not
 * found rather than guessed at.
 */
async function participantFields(api, who, prefix) {
    const wanted = fold(String(who).trim().replace(/^@/, ''));
    const { participants = [] } = await api.me();

    const typed = String(who).trim().replace(/^@/, '').toLowerCase();
    // Exactly as typed first; without the accent only when it can mean one person.
    const only = (found) => (found.length === 1 ? found[0] : undefined);
    const match =
        participants.find((person) => String(person.slug ?? '').toLowerCase() === typed) ??
        only(participants.filter((person) => fold(person.slug) === wanted)) ??
        only(participants.filter((person) => fold(person.handle) === wanted)) ??
        only(participants.filter((person) => fold(person.name) === wanted));

    if (!match) {
        throw new ChetoError(`Nobody here answers to "${who}". This workspace has: ${participants.map((person) => `@${person.slug} (${person.type})`).join(', ') || 'nobody'}.`);
    }

    return { [`${prefix}_type`]: match.type, [`${prefix}_id`]: match.id };
}

async function boardFor(api, area) {
    const wanted = String(area).trim().toLowerCase();
    const boards = await api.areas();

    const board =
        boards.find((candidate) => String(candidate.id) === wanted) ??
        boards.find((candidate) => String(candidate.slug ?? '').toLowerCase() === wanted) ??
        boards.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!board) {
        throw new ChetoError(`No board called "${area}" here. There is: ${boards.map((one) => one.slug).join(', ') || 'none'}.`);
    }

    return board;
}

export function isNobody(value) {
    return ['none', 'nobody', 'null'].includes(String(value).trim().toLowerCase());
}

function setIf(query, key, value) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
        query.set(key, String(value));
    }
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
