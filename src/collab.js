/**
 * The rest of the work, as the person: `cheto user …`.
 *
 * What an agent does with `cheto task show`, `cheto review …`, `cheto channel …`,
 * `cheto memory …` and `cheto search`, done by you on your own login and the
 * `/api/v1/cli` surface, attributed to you. Never `--agent` here: the split is
 * the same as for tasks — `cheto <verb>` is an agent, `cheto user <verb>` is you.
 *
 * Channels, memory and search need the `talk:read`/`talk:write` scopes, which a
 * login from before they existed does not carry; the client says what to do
 * about that (`SCOPE_HINT` in api.js).
 *
 * The workspace comes from `--workspace` or `CHETO_WORKSPACE`, as everywhere in
 * the person's commands. Reads that make sense across every workspace your
 * login reaches (`inbox`, `review list`) take it as an optional filter.
 */

import { ChetoError } from './api.js';
import { memoryChanges, printContext, printReviews, printTask, taskRef } from './agent-commands.js';
import { flag, flags, positionals } from './cli.js';
import { requireUser } from './human.js';
import { actorFields, workspaceOf } from './work.js';

const log = (...args) => console.log(...args);
const warn = (...args) => console.error(...args);

// ── Tasks ──────────────────────────────────────────────

/** `cheto user task show <id>` — one task in full, with comments and reviews. */
export async function userTaskShow(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto user task show <task-id> [--json]');

        return 1;
    }

    return withUser(async (api) => {
        const { data } = await api.task(taskRef(id));

        printTask(data, args);

        return 0;
    });
}

/** `cheto user task comment <id> <text>` */
export async function userTaskComment(args = []) {
    const [id, ...rest] = positionals(args);
    const body = rest.join(' ').trim();

    if (!id || !body) {
        warn('Usage: cheto user task comment <task-id> "what you want to say"');

        return 1;
    }

    return withUser(async (api) => {
        const task = taskRef(id);

        await api.comment(task, body, `cheto-user-comment-${task}-${slug(body)}`);

        log(`Commented on task ${task}.`);

        return 0;
    });
}

/**
 * `cheto user task assign <id> <who> --workspace <slug>`
 *
 * `who` is `me`, `none`, `user:<id>`, `agent:<id>`, or `@handle` of one of your
 * own agents in that workspace. The same PATCH as `user task update --assignee`.
 */
export async function userTaskAssign(args = []) {
    const [id, who] = positionals(args);

    if (!id || !who) {
        warn('Usage: cheto user task assign <task-id> <me|@agent|user:<id>|agent:<id>|none> [--workspace <slug>]');

        return 1;
    }

    return withUser(async (api) => {
        const task = taskRef(id);
        const body = await actorFields(api, args, who, 'assignee');
        const { data } = await api.updateTask(task, body, `cheto-user-assign-${task}-${slug(who)}`);

        log(body.assignee_id === null ? `${data?.key ?? `Task ${task}`} is held by nobody now.` : `${data?.key ?? `Task ${task}`} assigned to ${data?.assignee?.name ?? who}.`);

        return 0;
    });
}

// ── Reviews and what is waiting ────────────────────────

/** `cheto user review list [--workspace <slug>]` — reviews you owe an answer on. */
export async function userReviewList(args = []) {
    return withUser(async (api) => {
        const answer = await api.reviews(optionalWorkspace(args));

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        printReviews(Array.isArray(answer?.data) ? answer.data : [], 'cheto user review answer');

        return 0;
    });
}

/** `cheto user review request <task> <who> [--note]` — ask somebody to look. */
export async function userReviewRequest(args = []) {
    const [id, who] = positionals(args);

    if (!id || !who) {
        warn('Usage: cheto user review request <task-id> <@agent|user:<id>|agent:<id>> [--note "…"] [--workspace <slug>]');

        return 1;
    }

    return withUser(async (api) => {
        const task = taskRef(id);
        const body = { ...(await actorFields(api, args, who, 'reviewer')), ...optional('note', flag(args, '--note')) };

        await api.requestReview(task, body, `cheto-user-review-${task}`);

        log(`Asked ${who} to review task ${task}.`);

        return 0;
    });
}

/** `cheto user review answer <review> approved|changes_requested [--note]` */
export async function userReviewAnswer(args = []) {
    const [id, status] = positionals(args);

    if (!id || !['approved', 'changes_requested'].includes(String(status))) {
        warn('Usage: cheto user review answer <review-id> approved|changes_requested [--note "…"]');

        return 1;
    }

    return withUser(async (api) => {
        await api.answerReview(id, { status, ...optional('note', flag(args, '--note')) }, `cheto-user-answer-${id}`);

        log(`Answered review ${id}: ${status}.`);

        return 0;
    });
}

/** `cheto user inbox [--workspace <slug>]` — open work you hold, reviews you owe, unread notifications. */
export async function userInbox(args = []) {
    return withUser(async (api) => {
        const answer = await api.inbox(optionalWorkspace(args));

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        const tasks = answer.tasks ?? [];
        const reviews = answer.reviews ?? [];

        log('');
        log(`  ${tasks.length} open task${tasks.length === 1 ? '' : 's'}, ${reviews.length} review${reviews.length === 1 ? '' : 's'}, ${answer.unread_notifications ?? 0} unread notifications`);

        if (tasks.length > 0) {
            log('');
            tasks.forEach((task) => {
                log(`  ${String(task.id).padEnd(6)} ${String(task.key ?? '').padEnd(10)} ${String(task.status?.value ?? '').padEnd(12)} ${task.title}${task.due_on ? `  ·  due ${task.due_on}` : ''}`);
            });
        }

        if (reviews.length > 0) {
            printReviews(reviews, 'cheto user review answer');
        } else {
            log('');
        }

        return 0;
    });
}

// ── Channels ───────────────────────────────────────────

/** `cheto user channel list --workspace <slug>` */
export async function userChannelList(args = []) {
    return withUser(async (api) => {
        const answer = await api.channels(new URLSearchParams({ workspace: workspaceOf(args) }));

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

/** `cheto user channel read <slug|id> --workspace <slug>` — recent summaries and the messages after them. */
export async function userChannelRead(args = []) {
    const [channel] = positionals(args);

    if (!channel) {
        warn('Usage: cheto user channel read <slug|id> --workspace <slug> [--json]');

        return 1;
    }

    return withUser(async (api) => {
        printContext(await api.context(await channelId(api, args, channel)), args);

        return 0;
    });
}

/** `cheto user channel post <slug|id> <text> --workspace <slug>` — @handles resolve server-side. */
export async function userChannelPost(args = []) {
    const [channel, ...rest] = positionals(args);
    const body = rest.join(' ').trim();

    if (!channel || !body) {
        warn('Usage: cheto user channel post <slug|id> "what you want to say" --workspace <slug>');

        return 1;
    }

    return withUser(async (api) => {
        const id = await channelId(api, args, channel);

        await api.post(id, body, `cheto-user-post-${id}-${slug(body)}`);

        log(`Posted in ${String(channel).startsWith('#') ? channel : `#${channel}`}.`);

        return 0;
    });
}

// ── Memory ─────────────────────────────────────────────

/** `cheto user memory list --workspace <slug> [--key name] [--q text]` */
export async function userMemoryList(args = []) {
    return withUser(async (api) => {
        const query = new URLSearchParams({ workspace: workspaceOf(args) });

        setIf(query, 'key', flag(args, '--key'));
        setIf(query, 'q', flag(args, '--q'));
        setIf(query, 'limit', flag(args, '--limit'));

        const answer = await api.memories(query);
        const rows = answer.data ?? [];

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return 0;
        }

        if (rows.length === 0) {
            log('Nothing written down here yet.');

            return 0;
        }

        log('');
        rows.forEach((memory) => {
            log(`  ${memory.title}${memory.key ? `  (${memory.key})` : ''}  ·  memory ${memory.id}`);
            log(`    ${String(memory.body ?? '').replace(/\s+/g, ' ').slice(0, flag(args, '--key') ? Infinity : 200)}`);
            log('');
        });

        return 0;
    });
}

/** `cheto user memory write "Title" "Body" --workspace <slug> [--key name]` */
export async function userMemoryWrite(args = []) {
    const [title, body] = positionals(args);

    if (!title || !body) {
        warn('Usage: cheto user memory write "Title" "What to remember" --workspace <slug> [--key staging-access]');

        return 1;
    }

    return withUser(async (api) => {
        const workspace = workspaceOf(args);
        const key = flag(args, '--key');
        const { data } = await api.writeMemory({ workspace, title, body, ...optional('key', key) }, `cheto-user-memory-${slug(workspace)}-${slug(key ?? title)}`);

        log(`Remembered: ${data?.title ?? title}${data?.key ? `  (${data.key})` : ''}  ·  memory ${data?.id ?? '?'}`);

        return 0;
    });
}

/** `cheto user memory update <id> [--title] [--body] [--key name|none]` */
export async function userMemoryUpdate(args = []) {
    const [id] = positionals(args);
    const body = memoryChanges(args);

    if (!id || Object.keys(body).length === 0) {
        warn('Usage: cheto user memory update <memory-id> [--title "…"] [--body "…"] [--key staging-access|none]');

        return 1;
    }

    return withUser(async (api) => {
        await api.updateMemory(id, body);

        log(`Updated memory ${id}.`);

        return 0;
    });
}

/** `cheto user memory forget <id>` */
export async function userMemoryForget(args = []) {
    const [id] = positionals(args);

    if (!id) {
        warn('Usage: cheto user memory forget <memory-id>');

        return 1;
    }

    return withUser(async (api) => {
        await api.forgetMemory(id);

        log(`Forgot memory ${id}.`);

        return 0;
    });
}

// ── Search ─────────────────────────────────────────────

/** `cheto user search "text" --workspace <slug> [--kind task]... [--limit N] [--json]` — exit 1 when nothing matched. */
export async function userSearch(args = []) {
    const [text] = positionals(args);

    if (!text) {
        warn('Usage: cheto user search "what somebody said" --workspace <slug> [--kind message|task|comment|compact|memory]... [--limit 20] [--json]');

        return 1;
    }

    return withUser(async (api) => {
        const query = new URLSearchParams({ workspace: workspaceOf(args), q: text });

        flags(args, '--kind').forEach((kind) => query.append('kind[]', kind));
        setIf(query, 'limit', flag(args, '--limit'));

        const answer = await api.search(query);

        if (args.includes('--json')) {
            log(JSON.stringify(answer));

            return answer.total > 0 ? 0 : 1;
        }

        if (!answer.total) {
            log(`Nothing matched "${text}".`);

            return 1;
        }

        log('');
        (answer.results ?? []).forEach((hit) => {
            log(`  [${hit.kind}] ${hit.title}${hit.author ? `  ·  ${hit.author}` : ''}${hit.at ? `  ·  ${String(hit.at).slice(0, 10)}` : ''}`);
            log(`    ${String(hit.excerpt ?? '').replace(/\s+/g, ' ')}`);
            log('');
        });
        log(`  ${answer.total} result${answer.total === 1 ? '' : 's'}  ·  matched by ${answer.matched_by}`);
        log('');

        return 0;
    });
}

// ── Shared ────────────────────────────────────────────

async function withUser(work) {
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

/**
 * A channel as the id the person's surface takes.
 *
 * A slug is unique inside one workspace and a login reaches several, so a
 * slug is looked up in the named workspace first; a number is used as is.
 */
async function channelId(api, args, channel) {
    const wanted = String(channel).trim().replace(/^#/, '');

    if (/^\d+$/.test(wanted)) {
        return Number(wanted);
    }

    const workspace = workspaceOf(args);
    const { data: channels = [] } = await api.channels(new URLSearchParams({ workspace }));
    const match = channels.find((one) => String(one.slug ?? '').toLowerCase() === wanted.toLowerCase());

    if (!match) {
        throw new ChetoError(`No channel #${wanted} in ${workspace}. It has: ${channels.map((one) => `#${one.slug}`).join(', ') || 'none'}.`);
    }

    return match.id;
}

function optionalWorkspace(args) {
    const workspace = flag(args, '--workspace') ?? process.env.CHETO_WORKSPACE ?? null;

    return workspace && String(workspace).trim() !== '' ? new URLSearchParams({ workspace: String(workspace).trim() }) : null;
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
