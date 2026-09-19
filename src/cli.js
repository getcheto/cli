/**
 * The commands.
 *
 * `check` is the whole product in one pass: heartbeat, read the inbox, ask the
 * local policy what may be handed over, hand over only that, report back.
 * `run` is `check` in a loop. Everything else is setup.
 *
 * The policy step is the one that stops this being an autonomous daemon. It
 * used to be absent — work arrived, the runtime started — which made a board
 * assignment an instruction to somebody's laptop. See `src/policy.js`.
 */

import { hostname } from 'node:os';
import { ChetoApi, ChetoError } from './api.js';
import { runCommand, describeRuntime } from './adapters/command.js';
import { loadConfig } from './config.js';
import {
    forgetAgent,
    listAgentSessions,
    migrateLegacySession,
    rememberAgent,
    saveCredential,
    selectAgentSession,
    storeName,
} from './credentials.js';
import { loadLedger, saveLedger } from './ledger.js';
import { describeSchedule } from './schedule.js';
import { DEFAULT_MODE, chatKey, decide, fingerprintOf, reviewKey, toldKey } from './policy.js';
import { buildPrompt, idempotencyKeyFor } from './prompt.js';

const log = (...args) => console.log(...args);
const warn = (...args) => console.error(...args);

/** `cheto connect <code>` — redeem a pairing code from the Agents page. */
export async function connect(args) {
    const code = args[0];

    if (!code) {
        warn('Usage: cheto connect <pairing-code> [--url https://cheto.example]');
        warn('Get a code from the Agents page in Cheto: pick an agent, then Connect.');

        return 1;
    }

    const url = flag(args, '--url') ?? (await listAgentSessions())[0]?.url ?? (await ask('Cheto URL: '));

    if (!url) {
        warn('A Cheto URL is required.');

        return 1;
    }

    const device = flag(args, '--device') ?? hostname();
    const config = await loadConfig();

    // Before anything is written. An agent connected under the old
    // single-credential shape has to be moved out of the way, or the write
    // below lands on its key and it is gone.
    const moved = await migrateLegacySession();

    if (moved) {
        log(`  Moved the agent already on this machine (@${moved}) to its own credential.`);
    }

    let result;

    try {
        // What this machine is, and what it is running. Recorded on the
        // connection so a person can tell which laptop to disarm; it grants
        // nothing, and the server treats it as a claim rather than a fact.
        result = await ChetoApi.pair(url, code, {
            device,
            runtime_type: config?.runtime?.type ?? null,
            runtime_name: flag(args, '--runtime') ?? config?.runtime?.command ?? null,
        });
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }

    // The handle is the name this machine files the credential under, so a
    // second agent connecting is a second row rather than an overwrite.
    const handle = result.membership?.handle ?? result.agent.slug ?? 'default';

    // The credential goes straight to the keychain. It is never printed, so
    // there is nothing for a screen recording or a shell history to keep.
    const store = await saveCredential(url, handle, result.token);

    await rememberAgent({
        url,
        handle,
        agent: result.agent.name,
        workspace: result.workspace.name,
        // The identity this runtime acts as, in the form a person writes it.
        // A local adapter can put this in front of Claude or APX as context.
        mention: result.membership?.mention ?? null,
        connection: result.connection?.label ?? null,
        membership: result.membership?.id ?? null,
    });

    const others = (await listAgentSessions()).filter((entry) => entry.handle !== handle);

    log('');
    log('  Connected to Cheto');
    log(`  Workspace:  ${result.workspace.name}`);
    log(`  Acting as:  ${result.membership?.mention ?? result.agent.name}`);
    log(`  Machine:    ${result.connection?.label ?? device}`);
    log(`  Credential stored in: ${store}`);

    if (others.length > 0) {
        log('');
        log(`  Also connected here: ${others.map((entry) => `@${entry.handle}`).join(', ')}`);
        log('  Pick one with --agent <handle>.');
    }

    log('');
    log('  Nothing runs on its own. Start it yourself:');
    log('    cheto inbox check    one pass, machine-readable, quiet when idle');
    log('    cheto check          one pass, and run the agent if there is work');
    log('    cheto run            the same, waiting between passes');
    log('');

    return 0;
}

/**
 * `cheto inbox check` — is there anything, and what.
 *
 * The command for cron, and the conservative default: it reports and it does
 * not act. `--json` for a script, plain lines for a person, and **silence when
 * there is nothing** — a cron line that mails you on every quiet run is a cron
 * line you delete.
 *
 * Exit 0 either way. "Nothing was waiting" is a successful check.
 */
export async function inboxCheck(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const asJson = args.includes('--json');
    const config = await loadConfig();

    try {
        const inbox = await api.inbox({ waitSeconds: Number(flag(args, '--wait') ?? 0) });
        const offers = inbox.summary.offers ?? 0;

        if (!inbox.summary.has_work) {
            if (asJson) {
                log(
                    JSON.stringify({
                        has_work: false,
                        mode: config?.mode ?? DEFAULT_MODE,
                        agent: inbox.agent.name,
                        workspace: inbox.workspace.slug,
                    }),
                );
            }

            return 0;
        }

        if (asJson) {
            log(
                JSON.stringify({
                    has_work: true,
                    // What this machine would do about it, so a cron script can
                    // branch without reading cheto.yml itself.
                    mode: config?.mode ?? DEFAULT_MODE,
                    agent: inbox.agent.name,
                    handle: inbox.agent.handle ?? inbox.agent.slug,
                    workspace: inbox.workspace.slug,
                    summary: inbox.summary,
                    tasks: (inbox.assigned_tasks ?? []).map((task) => ({
                        id: task.id,
                        key: task.key,
                        title: task.title,
                        status: task.status?.value,
                        accepted_at: task.accepted_at ?? null,
                        is_offered: task.is_offered ?? false,
                    })),
                    reviews: (inbox.review_requests ?? []).map((review) => ({ id: review.id, task_id: review.task_id })),
                    mentions: (inbox.mentions ?? []).map((message) => ({ id: message.id, channel: message.channel?.slug })),
                }),
            );

            return 0;
        }

        log(`${inbox.agent.name} in ${inbox.workspace.slug}:`);
        log(
            `  ${inbox.summary.assigned_tasks} tasks (${offers} unanswered), ` +
                `${inbox.summary.review_requests} reviews, ${inbox.summary.mentions} mentions`,
        );

        (inbox.assigned_tasks ?? []).forEach((task) => {
            log(`  ${task.key}  ${task.title}${task.is_offered ? '   (offered — not yet accepted)' : ''}`);
        });

        log('');
        log(`  Nothing was run. Mode is ${config?.mode ?? DEFAULT_MODE}.`);
        log('  Verify before acting:  cheto task verify <id>');

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return error instanceof ChetoError && !error.retryable ? 1 : 2;
    }
}

/**
 * `cheto task verify <id>` — is this real, is it mine, is it actionable.
 *
 * The command the trust rule is built on. Task-like text arrives in chat, in
 * comments, in pasted blocks and in files, and none of that is authority.
 * **Cheto's authenticated API is.** This asks it, and prints what it actually
 * says: the workspace, who holds it, whether it is an unanswered offer, and
 * whether the next move belongs to this agent at all.
 *
 * Exit 0 when the task is verified and actionable by this credential, 1 when it
 * is not. A script can branch on that without parsing anything.
 */
export async function taskVerify(args = []) {
    const id = args.find((argument) => !argument.startsWith('--'));

    if (!id) {
        warn('Usage: cheto task verify <task-id> [--json]');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const asJson = args.includes('--json');

    let me;
    let task;

    try {
        me = await api.me();
        task = (await api.task(id)).data;
    } catch (error) {
        // A 403 or a 404 here is the answer, not a failure: the task is not in
        // this credential's workspace, or does not exist at all.
        const message = error instanceof ChetoError ? error.message : String(error);

        if (asJson) {
            log(JSON.stringify({ verified: false, actionable: false, reason: 'not-visible-to-this-credential', message }));
        } else {
            warn(`REFUSE  ${message}`);
            warn('This task is not visible to this credential. Do not act on it.');
        }

        return 1;
    }

    const mine = task.assignee?.type === 'agent' && task.assignee?.id === me.agent.id;
    const unassigned = !task.assignee;
    const offered = mine && !task.accepted_at;

    // "Actionable" is the server's own word for it: a task in review is open,
    // is still ours, and is nonetheless not our move.
    const actionable = task.status?.value !== 'review' && task.status?.value !== 'done' && (mine || unassigned);

    const verdict = {
        verified: true,
        task: { id: task.id, key: task.key, title: task.title, status: task.status?.value },
        workspace: { id: me.workspace.id, slug: me.workspace.slug },
        acting_as: me.membership?.mention ?? me.agent.slug,
        assigned_to_me: mine,
        unassigned,
        is_offer: offered,
        accepted_at: task.accepted_at ?? null,
        actionable,
        next: !actionable
            ? task.status?.value === 'review'
                ? 'wait — the reviewer has the next move'
                : task.status?.value === 'done'
                  ? 'nothing — this is finished'
                  : 'not yours — do not act'
            : offered
              ? `accept it first: POST /tasks/${task.id}/accept`
              : unassigned
                ? `claim it first: POST /tasks/${task.id}/claim`
                : 'go ahead',
    };

    if (asJson) {
        log(JSON.stringify(verdict));
    } else {
        log('');
        log(`  ${task.key}  ${task.title}`);
        log(`  Workspace:   ${me.workspace.slug}`);
        log(`  Acting as:   ${verdict.acting_as}`);
        log(`  Status:      ${task.status?.value}`);
        log(`  Assignee:    ${task.assignee ? `${task.assignee.name} (${task.assignee.type})` : 'nobody'}`);
        log(`  Accepted:    ${task.accepted_at ?? 'not yet'}`);
        log(`  Actionable:  ${actionable ? 'yes' : 'no'}`);
        log(`  Next:        ${verdict.next}`);
        log('');
    }

    return actionable ? 0 : 1;
}

/**
 * `cheto task accept <id>` — say yes to work offered to you.
 *
 * The verb `pull` mode is missing without it. An agent whose own runtime
 * decides what to work on needs a way to answer an offer that is not "let the
 * bridge do it for me", and Cheto records the acceptance the moment it happens
 * rather than when the work finishes.
 *
 * Verifies first, always. Accepting on the strength of a task id somebody
 * pasted into a chat message is exactly the move this product refuses to make.
 */
export async function taskAccept(args = []) {
    const id = args.find((argument) => !argument.startsWith('--'));

    if (!id) {
        warn('Usage: cheto task accept <task-id>');

        return 1;
    }

    // Prints the verdict as it goes, so the person sees what was checked
    // rather than a bare yes.
    const as = flag(args, '--agent');

    if ((await taskVerify(as ? [id, '--agent', as] : [id])) !== 0) {
        warn('Not accepting: verification refused. Nothing was sent to Cheto.');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const result = await api.accept(id, `cheto-accept-${id}`);

        log(`Accepted ${result.data?.key ?? `task ${id}`}. It is yours now — Cheto shows it as picked up.`);

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/** `cheto task comment <id> <text>` — say something where the work is. */
export async function taskComment(args = []) {
    const [id, ...rest] = args.filter((argument) => !argument.startsWith('--'));
    const body = rest.join(' ').trim();

    if (!id || !body) {
        warn('Usage: cheto task comment <task-id> "what you want to say"');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        await api.comment(id, body, `cheto-comment-${id}-${Date.now()}`);

        log(`Commented on task ${id}.`);

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

const TASK_TYPES = ['task', 'feature', 'bug', 'chore', 'epic', 'idea'];

/**
 * `cheto task type <id> <type>` — file it as what it actually is.
 *
 * The row somebody dropped on the board is often not a job: it is a thought, a
 * duplicate, or a bug wearing a feature's clothes. Answering that is the useful
 * half of triage and it is the half an agent can do safely, because saying what
 * something *is* decides nothing about who does it or whether it is done.
 */
export async function taskType(args = []) {
    const [id, type] = args.filter((argument) => !argument.startsWith('--'));

    if (!id || !TASK_TYPES.includes(String(type))) {
        warn(`Usage: cheto task type <task-id> <${TASK_TYPES.join('|')}>`);

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        // Keyed by what the change is, not by the clock: two passes deciding the
        // same thing must be one write, which is the whole point of a retry.
        await api.setType(id, type, `cheto-type-${id}-${type}`);

        log(`Task ${id} is now ${type === 'idea' || type === 'epic' ? 'an' : 'a'} ${type}.`);

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/** The five states underneath every board, whatever a team calls its columns. */
const TASK_STATUSES = ['inbox', 'ready', 'in_progress', 'review'];

/**
 * `cheto task move <id> "<column>"` — say where the work got to.
 *
 * The verb that was missing, and its absence had a cost somebody paid: on
 * 2026-09-18 an agent produced four reels, uploaded them, scheduled eight posts
 * and then could not say so. It commented the post ids on four tasks and left
 * them where they were, because commenting was the only thing it could do. The
 * board said "Listo" for work that was finished.
 *
 * Every other surface could already do this. The API has taken a status since
 * v1 and takes an exact column now; the MCP has had `cheto_task_status` since
 * 0.2.0. Only the terminal could not, so an agent living in a shell had to
 * reach for curl or give up. Most gave up.
 *
 * Two vocabularies, one move, and both are accepted here because agents are
 * written by people who think in either:
 *
 *   cheto task move 412 "Realizados — A postear"     # the board's own words
 *   cheto task move 412 review                       # the five states
 *
 * What it will not do is close anything. `done`, and any column that MEANS
 * done however it is spelled, is refused here before the request is made —
 * with the reason, because an agent that gets a bare 403 tries again. That
 * rule is not this command's to relax: finishing is a claim, done is a
 * judgement, and the owner makes it.
 */
export async function taskMove(args = []) {
    const [id, ...rest] = args.filter((argument) => !argument.startsWith('--'));
    const wanted = rest.join(' ').trim();

    if (!id || !wanted) {
        warn('Usage: cheto task move <task-id> "<column>"');
        warn(`       cheto task move <task-id> <${TASK_STATUSES.join('|')}>`);
        warn('Columns come from: cheto areas');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const { data: task } = await api.task(id);
        const body = await moveFor(api, task, wanted);

        // Keyed by where it is going, not by the clock: a pass that runs twice
        // deciding the same move has to be one write.
        const { data: moved } = await api.moveTask(id, body, `cheto-move-${id}-${slugify(wanted)}`);

        return reportMove(moved, body, wanted);
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * What to send for "put it here", from whatever the caller typed.
 *
 * Reads the task first because a column belongs to a board and the task
 * already knows which board it is on — asking for `--area` as well would be
 * asking the caller to repeat something we can look up, and every repetition
 * is a chance to name the wrong one.
 *
 * Sends the column *and* the status it means. The column is what this wants:
 * it names one specific card position, and a board with two columns of the
 * same meaning has two right answers that `status` cannot tell apart. The
 * status rides along so that a terminal on this version still moves work
 * against a Cheto that predates the endpoint reading `work_area_status_id` —
 * it lands a column over rather than not at all, and `report` says which.
 */
export async function moveFor(api, task, wanted) {
    const named = wanted.toLowerCase();

    if (task.work_area_id === null || task.work_area_id === undefined) {
        if (TASK_STATUSES.includes(named)) {
            return { status: named };
        }

        throw new ChetoError(
            `Task ${task.key ?? task.id} is not on any board, so it has no columns to move between. ` +
                `Name one of ${TASK_STATUSES.join(', ')} instead, or ask somebody to put it on a board.`,
        );
    }

    const boards = await api.areas();
    const board = boards.find((candidate) => String(candidate.id) === String(task.work_area_id));

    if (!board) {
        // The agent can see the task but not the board it is on. Falling back
        // to the five states is better than refusing: the move it asked for
        // still happens, and by a route that needs no board.
        if (TASK_STATUSES.includes(named)) {
            return { status: named };
        }

        throw new ChetoError(`This credential cannot see the board task ${task.key ?? task.id} is on, so "${wanted}" cannot be resolved to a column. Name one of ${TASK_STATUSES.join(', ')} instead.`);
    }

    const columns = board.statuses ?? [];
    const match =
        columns.find((candidate) => String(candidate.name ?? '').toLowerCase() === named) ??
        columns.find((candidate) => String(candidate.key ?? '').toLowerCase() === named);

    if (!match) {
        // A bare status word is a legitimate way to say this, and on a board
        // whose columns are renamed it is the only one the caller may know.
        if (TASK_STATUSES.includes(named)) {
            return { status: named };
        }

        throw new ChetoError(
            `"${board.name}" has no column called "${wanted}". It has: ${columns.map((one) => one.name).join(', ')}.`,
        );
    }

    const category = categoryOf(match);

    // The same refusal the server makes, made here so the answer is a sentence
    // rather than a bare 403. A team that renamed Done to "Posteados" has not
    // created a way around the rule, and an agent told only "forbidden" will
    // try the next column along.
    if (category === 'done') {
        throw new ChetoError(
            `"${match.name}" is a done column of "${board.name}", and an agent may never close its own work — whatever the column is called. ` +
                `Move it to review and say so: cheto task comment ${task.id} "..."`,
        );
    }

    return { work_area_status_id: match.id, ...(category ? { status: category } : {}) };
}

/**
 * Say where the card actually ended up, which is not always where it was sent.
 *
 * The check exists because the failure this command was written for was a
 * silent one: a field that validated, a 200, and a card that never moved. A
 * client that reports success on the strength of a 2xx would reproduce exactly
 * that, one layer up — so this reads the column out of the answer and compares
 * it to what was asked for.
 */
export function reportMove(moved, body, wanted) {
    const landed = moved.board_status;

    if (!landed) {
        // An older Cheto does not say where the card went. The status is all
        // there is, so report that and claim nothing about the column.
        log(`Task ${moved.key ?? moved.id} is now ${moved.status?.value ?? 'moved'}.`);

        return 0;
    }

    log(`${moved.key ?? moved.id}  ${moved.title ?? ''}`.trimEnd());
    log(`  now in ${landed.name}  (${moved.status?.value})`);

    if (body.work_area_status_id && String(landed.id) !== String(body.work_area_status_id)) {
        warn(`  asked for "${wanted}" and it landed in "${landed.name}" instead — this Cheto moves a card by what a column means, not by which one it is.`);
        warn('  Upgrade the server, or ask somebody to drag it the rest of the way.');

        return 1;
    }

    return 0;
}

/** A column's meaning, which the API sends as an object and older ones as a string. */
function categoryOf(column) {
    const category = column?.category;

    return typeof category === 'string' ? category : (category?.value ?? null);
}

/**
 * `cheto task create` — write something down from here.
 *
 * The command that was missing, and its absence was not a decision anybody
 * made: an agent could verify, accept, comment on and re-type a task from this
 * terminal but not write one, so anything it wanted to record had to go through
 * curl or through a runtime pass. The API has taken a task since v1.
 *
 * `--area` is the flag worth knowing. Without it the task lands on the agent's
 * own board when its membership names one, and on the workspace's first board
 * when it does not — so on a workspace with fourteen boards, an agent that never
 * says lands everything in the same place.
 *
 *   cheto task create "El cliente acepta o rechaza" --area marketing-reels
 *   cheto task create "Falla el alta" --area backlog-tecnico --column "Esperando"
 */
export async function taskCreate(args = []) {
    const title = args.filter((argument) => !argument.startsWith('--'))[0];

    if (!title) {
        warn('Usage: cheto task create "What it is" [--area <name|slug|id>] [--column "Name"]');
        warn('                       [--type bug] [--priority high] [--due 2026-09-30] [--tag reel]');
        warn('Boards come from: cheto areas');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const placement = await placementFor(api, flag(args, '--area'), flag(args, '--column'));

        const body = {
            title,
            ...placement,
            ...optional('description', flag(args, '--description')),
            ...optional('type', flag(args, '--type')),
            ...optional('priority', flag(args, '--priority')),
            ...optional('due_on', flag(args, '--due')),
            ...optional('status', flag(args, '--status')),
        };

        const tags = args.reduce((found, argument, index) => (argument === '--tag' && args[index + 1] ? [...found, args[index + 1]] : found), []);

        if (tags.length > 0) {
            body.tags = tags;
        }

        // Keyed by what the task is, not by the clock: a pass that runs twice
        // on the same idea has to produce one task, which is what a retry means.
        const { data } = await api.createTask(body, `cheto-create-${slugify(title)}`);

        log(`${data.key}  ${data.title}`);
        log(`  on ${areaNameOf(data)}${data.board_status ? ` · ${data.board_status.name}` : ''}`);

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * `cheto areas` — the boards of this workspace, and which one is this agent's.
 *
 * Here because `--area` needs somewhere to read its argument from, and because
 * "where does my work go" is a question an agent's operator asks before the
 * first task and never again.
 */
export async function areas(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const me = await api.me();
        const home = me.membership?.area ?? null;

        if (args.includes('--json')) {
            log(JSON.stringify({ home, areas: me.areas ?? [] }, null, 2));

            return 0;
        }

        log('');

        (me.areas ?? []).forEach((area) => {
            const mine = home && area.id === home.id;

            log(`  ${mine ? '*' : ' '} ${String(area.id).padEnd(4)} ${area.slug.padEnd(28)} ${area.name}`);
            log(`       ${(area.statuses ?? []).map((column) => column.name).join(' · ')}`);
        });

        log('');
        log(home ? `  * is this agent's own board. Work it creates lands there unless it says otherwise.` : '  This agent has no board of its own: work it creates lands on the first one.');
        log('');

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * A board, and optionally one of its columns, as the fields the API takes.
 *
 * Named in words here and resolved against what this credential can actually
 * see, so a board that does not exist **fails** with the list of ones that do.
 * The server used to take an unknown id and file the task on the first board
 * instead, which is how three hundred tasks ended up in the wrong place.
 */
async function placementFor(api, area, column) {
    if (!area) {
        if (column) {
            throw new ChetoError('A column belongs to a board, so --column needs --area as well. Run: cheto areas');
        }

        return {};
    }

    const wanted = String(area).trim().toLowerCase();
    const boards = await api.areas();

    const board =
        boards.find((candidate) => String(candidate.id) === wanted) ??
        boards.find((candidate) => String(candidate.slug ?? '').toLowerCase() === wanted) ??
        boards.find((candidate) => String(candidate.name ?? '').toLowerCase() === wanted);

    if (!board) {
        throw new ChetoError(`No board called "${area}" here. There is: ${boards.map((one) => one.slug).join(', ') || 'none'}.`);
    }

    if (!column) {
        return { work_area_id: board.id };
    }

    const named = String(column).trim().toLowerCase();
    const match = (board.statuses ?? []).find(
        (candidate) => String(candidate.name ?? '').toLowerCase() === named || String(candidate.key ?? '').toLowerCase() === named,
    );

    if (!match) {
        throw new ChetoError(`"${board.name}" has no column called "${column}". It has: ${(board.statuses ?? []).map((one) => one.name).join(', ')}.`);
    }

    // The column alone: it names its own board, and sending both is two chances
    // to disagree, which the server refuses rather than guesses at.
    return { work_area_status_id: match.id };
}

function areaNameOf(task) {
    return (task.areas ?? []).find((placement) => placement.is_home)?.area?.name ?? `area ${task.work_area_id}`;
}

function optional(field, value) {
    return value ? { [field]: value } : {};
}

function slugify(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

/**
 * `cheto memory` — what the workspace knows, as against what it said.
 *
 * The third thing an agent needs, after a bounded read and a way to search:
 * somewhere to put what it worked out. An agent that rediscovers the same fact
 * every week is exactly as expensive as one that reads the whole channel.
 *
 *   cheto memory                       everything, newest first
 *   cheto memory get <name>            one, by the name it answers to
 *   cheto memory write "Title" "Body"  [--key staging-access]
 *   cheto memory forget <id>
 */
export async function memoryList(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const { data } = await api.memories({ q: flag(args, '--q') });

        if (data.length === 0) {
            log('Nothing written down yet. Add one: cheto memory write "Title" "What to remember"');

            return 0;
        }

        log('');

        for (const memory of data) {
            log(`  ${memory.title}${memory.key ? `  (${memory.key})` : ''}  ·  memory ${memory.id}`);
            log(`    ${memory.body.replace(/\s+/g, ' ').slice(0, 200)}`);
            log('');
        }

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/** `cheto memory get <name>` — the whole of one, by the name it answers to. */
export async function memoryGet(args = []) {
    const key = args.find((argument) => !argument.startsWith('--'));

    if (!key) {
        warn('Usage: cheto memory get <name>');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const { data } = await api.memories({ key });

        if (data.length === 0) {
            warn(`No memory answers to "${key}".`);

            return 1;
        }

        log('');
        log(`  ${data[0].title}`);
        log('');
        log(data[0].body);
        log('');

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/** `cheto memory write "Title" "What to remember" [--key name]` */
export async function memoryWrite(args = []) {
    const [title, body] = args.filter((argument) => !argument.startsWith('--'));

    if (!title || !body) {
        warn('Usage: cheto memory write "Title" "What to remember" [--key staging-access]');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const key = flag(args, '--key');

    try {
        // Keyed on the name where there is one, so writing the same conclusion
        // twice updates one note rather than making a second.
        const { data } = await api.writeMemory({ title, body, key: key ?? undefined }, `cheto-memory-${key ?? title}`);

        log(`  Remembered: ${data.title}${data.key ? `  (${data.key})` : ''}  ·  memory ${data.id}`);

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/** `cheto memory forget <id>` — only what this agent wrote. */
export async function memoryForget(args = []) {
    const id = args.find((argument) => !argument.startsWith('--'));

    if (!id) {
        warn('Usage: cheto memory forget <memory-id>     (cheto memory shows them)');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        await api.forgetMemory(id);

        log(`Forgot memory ${id}.`);

        return 0;
    } catch (error) {
        // A refusal here is the policy, not a fault: an agent may remove what
        // it wrote and nothing else.
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * `cheto search "what somebody said"` — reach past the last ten messages.
 *
 * The command that makes bounded context bearable. An agent's prompt holds a
 * few compacts and a handful of messages; everything older is one question
 * away. "I do not remember, but I can look it up" is a better shape for a
 * colleague than "I read everything, always" — and it is the shape that costs
 * the same on day two hundred as on day two.
 *
 * `--json` for a script, lines for a person. Exit 1 when nothing matched, so a
 * shell can branch on it without parsing anything.
 */
export async function search(args = []) {
    const query = args.filter((argument) => !argument.startsWith('--'))[0];

    if (!query) {
        warn('Usage: cheto search "what somebody said" [--kind message|task|comment|compact] [--limit 20] [--json]');

        return 1;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const asJson = args.includes('--json');

    // Repeatable: `--kind task --kind comment` narrows to both.
    const kinds = args.reduce((found, argument, index) => (argument === '--kind' && args[index + 1] ? [...found, args[index + 1]] : found), []);

    let answer;

    try {
        answer = await api.search(query, { kinds, limit: Number(flag(args, '--limit') ?? 0) });
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }

    if (asJson) {
        log(JSON.stringify(answer));

        return answer.total > 0 ? 0 : 1;
    }

    if (answer.total === 0) {
        log(`Nothing matched "${query}".`);

        return 1;
    }

    log('');

    for (const hit of answer.results) {
        const where = hit.kind === 'message' || hit.kind === 'compact' ? hit.title : hit.title;

        log(`  [${hit.kind}] ${where}${hit.author ? `  ·  ${hit.author}` : ''}${hit.at ? `  ·  ${hit.at.slice(0, 10)}` : ''}`);
        log(`    ${hit.excerpt.replace(/\s+/g, ' ')}`);
        log('');
    }

    log(`  ${answer.total} result${answer.total === 1 ? '' : 's'}  ·  matched by ${answer.matched_by}`);
    log('');

    return 0;
}

/**
 * `cheto compact` — fold a channel's history so reading it stays affordable.
 *
 * The other half of an arrangement Cheto deliberately only does half of. Cheto
 * counts the messages and says when a fold is due; it has no model and no key,
 * so it never writes one. This does — with the runtime already configured on
 * this machine, and the tokens that runtime is already spending.
 *
 * Which is why it is a command rather than something `check` does on its own.
 * Summarising costs money, and money spent without being asked is money
 * somebody finds out about later. Put it in cron next to `check` if you want it
 * to happen by itself; that is a decision with a bill attached and it should be
 * one somebody made.
 */
export async function compact(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const config = await loadConfig();
    const entry = entryFor(config, session.handle) ?? {};
    const wanted = flag(args, '--channel');

    let channels;

    try {
        channels = (await api.channels()).data ?? [];
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }

    const targets = wanted
        ? channels.filter((channel) => String(channel.slug) === wanted || String(channel.id) === wanted)
        : channels;

    if (targets.length === 0) {
        warn(wanted ? `No channel called "${wanted}" in ${session.workspace ?? 'this workspace'}.` : 'No channels here.');

        return 1;
    }

    let folded = 0;

    for (const channel of targets) {
        let pending;

        try {
            pending = await api.pendingCompact(channel.id);
        } catch (error) {
            warn(`#${channel.slug}: ${error instanceof ChetoError ? error.message : String(error)}`);

            continue;
        }

        if (!pending.compact_due) {
            // Silence on a channel that does not need one: this is meant to be
            // safe to run over every channel, and a report per quiet channel is
            // a report nobody reads.
            continue;
        }

        const prompt = compactPrompt(channel, pending.data ?? []);

        if (!describeRuntime(entry.runtime)) {
            log('');
            log(prompt);
            log('');
            warn(`No runtime configured in cheto.yml — nothing was written for #${channel.slug}.`);

            continue;
        }

        const result = await runCommand({
            command: entry.runtime.command,
            args: entry.runtime.args ?? [],
            cwd: entry.workspacePath ?? config?.workspacePath,
            prompt,
        });

        if (!result.ok || !result.output?.trim()) {
            warn(`#${channel.slug}: the runtime produced nothing. Not folding a channel on an empty summary.`);

            continue;
        }

        try {
            // Keyed on the span rather than the clock: a retry after a lost
            // response must be the same request, or one fold becomes two.
            await api.postCompact(channel.id, result.output.trim(), `cheto-compact-${channel.id}-${pending.data.at(-1)?.id}`);

            log(`  folded ${pending.count} messages in #${channel.slug}`);
            folded += 1;
        } catch (error) {
            warn(`#${channel.slug}: ${error instanceof ChetoError ? error.message : String(error)}`);
        }
    }

    if (folded === 0) {
        log('Nothing to fold.');
    }

    return 0;
}

/**
 * What the runtime is asked for.
 *
 * Explicit about the audience, because a summary written for a person and one
 * written for an agent picking up a thread are different documents — and this
 * one is read by both, so it has to be the short factual kind.
 */
export function compactPrompt(channel, messages) {
    const lines = [
        `Summarise this conversation from #${channel.slug} so that somebody arriving now knows where things stand.`,
        '',
        'Write 3 to 6 sentences of plain prose. Say what was decided, what is still open, and who is doing what.',
        'Name people and agents by the handles used below. Do not invent anything that is not here.',
        'Write only the summary — no preamble, no heading, no closing remark.',
        '',
        `## ${messages.length} messages`,
        '',
    ];

    for (const message of messages) {
        lines.push(`${message.author?.name ?? 'somebody'}: ${message.body}`);
    }

    return lines.join('\n');
}

/** One line explaining what a mode lets this machine do. */
function describeMode(mode) {
    return {
        off: '— nothing is handed to the runtime',
        notify: '— chat may wake the runtime, tasks never start on their own',
        pull: '— nothing starts on its own; you run it',
        auto: '— eligible tasks may start, inside the configured hours',
    }[mode] ?? '';
}

/** `cheto status` — who am I, where am I, is there work. */
export async function status(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });

    try {
        const me = await api.me();
        const inbox = await api.inbox();
        const config = await loadConfig();
        const entry = entryFor(config, session.handle) ?? {};

        log('');
        log(`  Cheto:      ${session.url}`);
        log(`  Workspace: ${me.workspace.name}`);
        log(`  Agent:     ${me.agent.name}  (${me.agent.status.value})`);
        log(`  Secrets:   ${await storeName()}`);
        log(`  Runtime:   ${describeRuntime(entry.runtime) ?? 'not configured — cheto will print work instead of running anything'}`);
        log(`  Mode:      ${entry.mode ?? DEFAULT_MODE}  ${describeMode(entry.mode ?? DEFAULT_MODE)}`);

        const schedule = describeSchedule(entry.automation?.tasks?.schedule);

        if (entry.automation?.tasks?.enabled === true) {
            log(`  Automation: tasks enabled  ·  ${schedule.configured ? schedule.reason : 'any hour'}`);
        }

        if (config?.path) {
            log(`  Config:    ${config.path}`);
        }
        log('');
        log(`  Waiting:   ${inbox.summary.review_requests} reviews, ${inbox.summary.assigned_tasks} tasks, ${inbox.summary.mentions} mentions`);

        // Everything else armed on this machine. Not decoration: the whole
        // reason this command used to be wrong is that a second agent was
        // invisible right up until it was gone.
        const others = (await listAgentSessions()).filter((known) => known.handle !== session.handle);

        if (others.length > 0) {
            log('');
            log('  Also connected here:');
            others.forEach((known) => log(`    @${known.handle}  ${known.workspace ?? ''}  ${known.connection ?? ''}`.trimEnd()));
            log('  Run one of them with --agent <handle>.');
        }

        log('');

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return 1;
    }
}

/**
 * `cheto check` — one pass.
 *
 * Heartbeat, read the inbox, ask the policy, hand over what it allows, report.
 * Returns 0 whether or not there was anything to do: "nothing was waiting" is a
 * successful check, and a cron line that mails you on every quiet run is a cron
 * line you delete.
 *
 * The default is `notify`. Chat can reach the agent; a task cannot start it.
 * `--run` overrides the policy for this one pass, because a person typing it is
 * an authority a config file is not.
 */
export async function check(args = [], state = {}) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const api = new ChetoApi({ url: session.url, token: session.token });
    const config = await loadConfig();
    const entry = entryFor(config, session.handle);

    if (entry === null) {
        warn(`cheto.yml describes several agents and none of them is @${session.handle}.`);
        warn('Add an entry for it, or run the one this checkout is for with --agent.');

        return 1;
    }

    const waitSeconds = Number(flag(args, '--wait') ?? 0);
    const quiet = args.includes('--quiet');

    try {
        // Presence, always. Being reachable is not the same as being willing,
        // and a machine that hides while it is on is a machine nobody can find
        // to disarm.
        await api.heartbeat('online');

        const inbox = await api.inbox({ waitSeconds });

        state.cursor = inbox.cursor ?? null;

        // `--handover` follows the convention a cron expects: exit 1 means "there
        // was nothing new, do not wake the model". Without it a scheduler either
        // spends tokens on every empty pass or has to parse this output to find
        // out it was empty.
        const handover = args.includes('--handover');

        if (!inbox.summary.has_work) {
            if (!quiet) {
                log('Nothing waiting.');
            }

            return handover ? 1 : 0;
        }

        const ledger = await loadLedger(session.url, session.handle);

        const decision = decide({
            inbox,
            config: entry,
            now: new Date(),
            force: args.includes('--run'),
            handled: (id) => ledger[String(id)] ?? null,
        });

        // Everything the server is holding was already said by this machine on an
        // earlier pass. Not silence about the work — silence about repeating it.
        const fresh =
            decision.chat.items.length + decision.tasks.held.length + decision.tasks.eligible.length + decision.reviews.held.length + decision.reviews.eligible.length;

        if (handover && fresh === 0) {
            if (!quiet) {
                log('Nothing new since the last pass.');
            }

            return 1;
        }

        log(
            `Work: ${inbox.summary.review_requests} reviews, ` +
                `${inbox.summary.assigned_tasks} tasks, ${inbox.summary.mentions} mentions` +
                `  ·  mode: ${decision.mode}${decision.forced ? ' (overridden)' : ''}`,
        );

        decision.notices.forEach((notice) => log(`  ${notice}`));

        // Reported, never done here. Folding costs tokens, and `check` is the
        // command people put in cron — it must not quietly start spending.
        (inbox.compacts_due ?? []).forEach((due) => {
            log(`  #${due.channel.slug} has ${due.uncompacted} messages nobody has summarised — cheto compact --channel ${due.channel.slug}`);
        });

        // Everything the policy held, and why. This is the line that makes a
        // passive default legible: "there is a task and I am not starting it"
        // has to be visible, or it reads as the bridge being broken.
        for (const { item, reason } of [...decision.tasks.held, ...decision.reviews.held]) {
            log(`  held  ${item.key ?? `review #${item.id}`} — ${reason}`);
        }

        if (!decision.wake) {
            log('  Nothing was handed to the runtime.');

            if (decision.tasks.held.length > 0) {
                log('  To act on one:  cheto task verify <id>  then  cheto task accept <id>');
            }

            // The held list above is the whole output of a `notify` pass, and
            // under `--handover` it is what the scheduler feeds its model. So it
            // counts as having been said, exactly like a prompt does — otherwise
            // the one path that produces the most passes is the one that never
            // remembers them.
            if (handover) {
                recordPass(ledger, decision);
                await saveLedger(session.url, session.handle, ledger);
                await api.markNotificationsRead();
            }

            return 0;
        }

        const prompt = buildPrompt(inbox, {
            agentName: inbox.agent.name,
            workspaceName: inbox.workspace.name,
            url: session.url,
            // Who this runtime is acting as, from the credential rather than
            // from anything in a config file.
            mention: session.mention ?? (inbox.agent.handle ? `@${inbox.agent.handle}` : null),
            decision,
        });

        // No runtime configured: print what an agent would have been handed
        // and change nothing. Useful on its own — it is how you check the
        // context package looks right before pointing a model at it, and it
        // has to stay a dry run for that to be worth anything.
        if (!decision.runtimeConfigured) {
            log('');
            log(prompt);
            log('');

            // `--handover` is for the arrangement where something else runs the
            // model — a cron that pipes this into an agent, say. Printing is the
            // delivery there, so the pass has to be remembered or the next one
            // prints the same thing and the agent is woken about TASK-42 forever.
            //
            // Without the flag this stays a dry run, which is the whole point of
            // being able to look at the prompt before pointing a model at it.
            if (handover) {
                recordPass(ledger, decision);
                await saveLedger(session.url, session.handle, ledger);
                await api.markNotificationsRead();
                warn('No runtime here — the prompt above was handed over, and this pass will not repeat.');
            } else {
                warn('No runtime configured in cheto.yml — nothing was run and nothing was accepted.');
            }

            return 0;
        }

        /*
         * Accept, now that there is something to hand the work to.
         *
         * After the runtime check and not before: accepting is a public
         * statement that this agent has picked the task up, and making it on
         * behalf of a runtime that does not exist tells everybody looking at
         * the board something untrue.
         */
        for (const task of decision.tasks.eligible) {
            if (task.is_offered) {
                try {
                    await api.accept(task.id, `cheto-accept-${task.id}`);
                    log(`  accepted ${task.key}`);
                } catch (error) {
                    // Somebody else got there, or it moved. Not our work now.
                    log(`  could not accept ${task.key}: ${error.message}`);
                }
            }
        }

        await api.heartbeat('busy');

        const result = await runCommand({
            command: entry.runtime.command,
            args: entry.runtime.args ?? [],
            cwd: entry.workspacePath ?? config?.workspacePath,
            prompt,
        });

        await api.heartbeat('online');

        if (!result.ok) {
            warn(`Runtime failed: ${result.error}`);

            return 1;
        }

        await report(api, inbox, decision, result.output);

        // Only what was actually handed over, and only after it was reported.
        // A task recorded as handled that the runtime never saw is a task that
        // silently never gets done.
        recordPass(ledger, decision);

        await saveLedger(session.url, session.handle, ledger);

        // Only after the work has actually been reported. Marking read first
        // and then failing would lose the only record that the agent was told.
        await api.markNotificationsRead();

        log('Reported back to Cheto.');

        return 0;
    } catch (error) {
        warn(error instanceof ChetoError ? error.message : String(error));

        return error instanceof ChetoError && !error.retryable ? 1 : 2;
    }
}

/**
 * `cheto run` — check, forever.
 *
 * Between passes it asks the server to hold the connection until something
 * happens, so an assignment reaches the agent in about a second rather than on
 * the next tick. If the server does not support waiting, this degrades to a
 * plain poll on its own.
 */
export async function run(args = []) {
    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const wait = Number(flag(args, '--wait') ?? 25);
    const floor = Number(flag(args, '--interval') ?? 5);

    log(`  Listening. Cheto: ${session.url}  ·  agent: ${session.mention ?? session.agent ?? 'unknown'}`);
    log('  Ctrl-C to stop.');
    log('');

    let backoff = floor;
    let lastCursor = null;
    let idle = 0;

    for (;;) {
        const state = {};
        const code = await check([...args, '--wait', String(wait), '--quiet'], state);

        if (code === 2) {
            // Reachable-but-unhappy, or unreachable. Back off rather than
            // hammering something that is already having a bad time.
            warn(`Retrying in ${backoff}s`);
            await sleep(backoff * 1000);
            backoff = Math.min(backoff * 2, 300);

            continue;
        }

        if (code === 1) {
            warn('Stopping: this will not fix itself.');

            return 1;
        }

        backoff = floor;

        /*
         * A held task is work the server still calls work.
         *
         * The long poll returns immediately whenever the inbox is non-empty, so
         * a task the policy refuses to start would spin this loop every few
         * seconds forever, re-printing the same refusal. When the cursor has
         * not moved there is nothing new to decide, so back off — up to a
         * minute — and let the wait do its job again once it does.
         */
        if (state.cursor !== null && state.cursor === lastCursor) {
            idle = Math.min(idle === 0 ? floor : idle * 2, 60);
        } else {
            idle = 0;
            lastCursor = state.cursor;
        }

        await sleep(Math.max(floor, idle) * 1000);
    }
}

/**
 * `cheto logout` — forget one agent's credential on this machine.
 *
 * One, not all. A machine running three agents that loses all three because
 * somebody signed one out is a machine nobody trusts with the second one.
 * `--all` is there for a laptop being handed on.
 */
export async function logout(args = []) {
    const sessions = await listAgentSessions();

    if (sessions.length === 0) {
        log('Not connected.');

        return 0;
    }

    if (args.includes('--all')) {
        for (const entry of sessions) {
            await forgetAgent(entry.url, entry.handle);
        }

        log(`Disconnected ${sessions.map((entry) => `@${entry.handle ?? '?'}`).join(', ')}.`);
        log('The credentials still exist in Cheto — revoke them there if this machine is gone for good.');

        return 0;
    }

    const session = await requireSession(args);

    if (!session) {
        return 1;
    }

    const store = await forgetAgent(session.url, session.handle);
    const left = await listAgentSessions();

    log(`Disconnected @${session.handle ?? '?'}. Credential removed from ${store}.`);

    if (left.length > 0) {
        log(`Still connected here: ${left.map((entry) => `@${entry.handle}`).join(', ')}`);
    }

    log('The credential still exists in Cheto — revoke it there if this machine is gone for good.');

    return 0;
}

/**
 * Report what the agent did.
 *
 * A comment on the task it was working on, so the note lands where the work is
 * rather than in a room. Falls back to nothing: an agent that produced no
 * output has nothing to say, and a "done" with no content is noise.
 */
/**
 * What this pass counts as having said, so it is not said again.
 *
 * Two kinds, and the difference matters the day somebody turns automation on:
 * a task actually handed to a runtime is stored under its bare fingerprint,
 * which is what `auto` compares against; a task merely reported is stored under
 * `toldKey`, which nothing compares against — so it stops the repetition
 * without ever looking like work already done.
 */
function recordPass(ledger, decision) {
    for (const task of decision.tasks.eligible) {
        ledger[String(task.id)] = fingerprintOf(task);
    }

    // Held work is still work this machine has now told somebody about, and an
    // assigned task does not leave the inbox until it is finished.
    for (const { item } of decision.tasks.held) {
        ledger[String(item.id)] = toldKey(item);
    }

    for (const { item } of decision.reviews.held) {
        ledger[reviewKey(item)] = 'told';
    }

    for (const review of decision.reviews.eligible) {
        ledger[reviewKey(review)] = 'told';
    }

    for (const item of decision.chat.allowed ? decision.chat.items : []) {
        ledger[chatKey(item)] = 'answered';
    }
}

async function report(api, inbox, decision, output) {
    if (!output) {
        return;
    }

    const key = idempotencyKeyFor(inbox);

    // Only somewhere the policy actually released. Commenting on a task that
    // was held would put an agent's opinion on work it was told not to touch —
    // which is how a passive mode still ends up looking like participation.
    const task = decision.tasks.eligible[0] ?? decision.reviews.eligible[0]?.task;

    if (task?.id) {
        await api.comment(task.id, output, key);

        return;
    }

    const channel = inbox.mentions?.[0]?.channel?.slug;

    if (channel) {
        await api.post(channel, output, key);
    }
}

/**
 * The `cheto.yml` entry that describes what to run for this agent.
 *
 * A file with one entry describes this machine, whatever it calls the agent —
 * `agent:` there is a label, and a single-entry config is unambiguous about
 * what runs here. A file with several is a machine running several, and picking
 * the first when none matches would hand one agent's work to another's runtime.
 * So that case refuses.
 */
function entryFor(config, handle) {
    const entries = config?.agents ?? [];

    if (entries.length <= 1) {
        return entries[0] ?? config ?? {};
    }

    return entries.find((entry) => String(entry.agent ?? '').toLowerCase() === String(handle ?? '').toLowerCase()) ?? null;
}

/**
 * The agent this command speaks as.
 *
 * `--agent <handle>` first, then whatever `cheto.yml` names first, then the only
 * one connected. When several are connected and nothing picks between them it
 * refuses and lists them: acting as the wrong agent is a comment in somebody
 * else's name, and there is no undoing that from here.
 */
async function requireSession(args = []) {
    const config = await loadConfig();
    const { session, sessions, reason } = await selectAgentSession({
        handle: flag(args, '--agent'),
        preferred: config?.agents?.[0]?.agent ?? null,
    });

    if (session) {
        return session;
    }

    if (reason === 'none') {
        warn('Not connected. Run: cheto connect <pairing-code>');
        warn('Get a code from the Agents page in Cheto.');

        return null;
    }

    if (reason === 'unknown') {
        warn(`No agent called "${flag(args, '--agent')}" is connected on this machine.`);
    } else {
        warn('Several agents are connected here and nothing says which one to use.');
    }

    warn(`Connected: ${sessions.map((entry) => `@${entry.handle ?? '?'} (${entry.workspace ?? '?'})`).join(', ')}`);
    warn('Pick one with --agent <handle>, or name it first in cheto.yml.');

    return null;
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
