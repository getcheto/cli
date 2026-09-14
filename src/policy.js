/**
 * What this machine is allowed to do with what it just found.
 *
 * The bridge used to answer one question — "is there work?" — and start the
 * agent if the answer was yes. That made an assignment an instruction: a task
 * dropped on a board woke a model on somebody's laptop and it began, because
 * nothing in between was empowered to say no.
 *
 * This module is that missing step. It takes an inbox and the local config and
 * returns a decision: which items may be handed to the runtime, which are only
 * being reported, and why each one fell where it did. It reads nothing, writes
 * nothing and calls nothing, so the rules can be tested without a server.
 *
 * The distinction it exists to keep:
 *
 *     chat may notify          a mention is a conversation, and answering is cheap
 *     tasks do not execute     a task is authorised work, and starting it is not
 *
 * Modes, least to most permissive:
 *
 *   off      Nothing is handed over. Presence only.
 *   notify   **Default.** Chat may wake the runtime. Tasks are reported.
 *   pull     Nothing is handed over on its own; you run it. Everything reported.
 *   auto     Opt-in. Tasks matching the filters, inside the hours, may run.
 *
 * `notify` and `pull` differ in who starts the runtime, not in what tasks are
 * allowed to do — which is nothing, in both.
 */

import { describeSchedule } from './schedule.js';

export const MODES = ['off', 'notify', 'pull', 'auto'];

export const DEFAULT_MODE = 'notify';

/**
 * Notification keys that are somebody talking to this agent.
 *
 * Chat class, not work class. A comment on a task is a conversation about work;
 * it is not permission to do the work.
 *
 * `notifications.cheto.mentioned` is deliberately absent. A channel mention
 * writes both a mention row and a notification, and the row carries the body
 * and the channel while the notification carries neither — so counting both
 * showed every mention twice, the second time with nothing in it.
 */
const CHAT_NOTIFICATIONS = new Set([
    'notifications.cheto.task_commented',
    'notifications.cheto.task_comment_mentioned',
]);

/**
 * @param {object}  options
 * @param {object}  options.inbox    the `GET /inbox` payload
 * @param {object}  options.config   the parsed cheto.yml entry for this agent
 * @param {Date}    options.now      injected so the schedule is testable
 * @param {boolean} options.force    a person typed `--run`: their call, this pass
 * @param {(id: number) => string|null} options.handled  last handover fingerprint
 */
export function decide({ inbox, config = {}, now = new Date(), force = false, handled = () => null } = {}) {
    const mode = normaliseMode(config.mode);
    const automation = config.automation?.tasks ?? {};
    const runtimeConfigured = config.runtime?.type === 'command' && Boolean(config.runtime.command);

    // Chat that has not been answered from this machine yet.
    //
    // A channel mention has no read state — the inbox returns the last 25
    // whatever happened to them — so without this a single "hola" keeps
    // `has_work` true and wakes the runtime on every pass, forever. Which
    // message this machine has already replied to is local knowledge, exactly
    // like which task it has already handed over.
    const chat = collectChat(inbox).filter((item) => handled(chatKey(item)) === null);

    const reviews = inbox.review_requests ?? [];
    const tasks = inbox.assigned_tasks ?? [];

    // Chat may wake the runtime in every mode that is awake at all. `pull` is
    // the deliberate exception: it means "I decide when anything runs".
    const chatAllowed = mode === 'notify' || mode === 'auto';

    const decision = {
        mode,
        forced: force,
        runtimeConfigured,
        chat: { items: chat, allowed: chatAllowed && chat.length > 0 },
        tasks: { eligible: [], held: [] },
        reviews: { eligible: [], held: [] },
        schedule: null,
        notices: [],
    };

    if (mode === 'off') {
        decision.chat.allowed = false;
        hold(decision.tasks, tasks, 'mode is off');
        hold(decision.reviews, reviews, 'mode is off');
        decision.notices.push('Mode is off. Nothing was handed to the runtime.');

        return finish(decision, force, tasks, reviews);
    }

    if (mode !== 'auto') {
        // The whole point of the default. Reported, listed, never started.
        const because = mode === 'pull' ? 'mode is pull — you decide when to run' : 'mode is notify — tasks never auto-execute';

        // Only what has not been said already, and only here.
        //
        // Exactly the reasoning applied to chat above, which tasks never got: an
        // assigned task stays in the inbox until somebody finishes it, so a cron
        // in `notify` woke the runtime with the same TASK-42 every pass until a
        // human closed it — spend that looks like diligence and is a loop.
        //
        // Filtered in this branch rather than at the top, because `auto` decides
        // what to *execute* and must not inherit silence from a pass that merely
        // mentioned the work. Keyed by fingerprint, so a task that moves, is
        // commented on or is accepted has something new to say and says it.
        const unsaid = tasks.filter((task) => handled(task.id) !== toldKey(task));
        const unanswered = reviews.filter((review) => handled(reviewKey(review)) === null);

        hold(decision.tasks, unsaid, because);
        hold(decision.reviews, unanswered, because);

        return finish(decision, force, unsaid, unanswered);
    }

    if (automation.enabled !== true) {
        hold(decision.tasks, tasks, 'automation.tasks.enabled is not true');
        hold(decision.reviews, reviews, 'automation.tasks.enabled is not true');
        decision.notices.push('Mode is auto but automation.tasks.enabled is not true. Tasks were only reported.');

        return finish(decision, force, tasks, reviews);
    }

    const schedule = describeSchedule(automation.schedule, now);
    decision.schedule = schedule;

    if (!schedule.inside) {
        // Held, not dropped. The work stays in Cheto exactly as it was and the
        // window opening is enough for the next pass to pick it up.
        hold(decision.tasks, tasks, schedule.reason);
        hold(decision.reviews, reviews, schedule.reason);
        decision.notices.push(`Outside working hours (${schedule.reason}). Nothing was started; the work is still waiting.`);

        return finish(decision, force, tasks, reviews);
    }

    const routed = routingMismatch(automation.notify, inbox);

    if (routed) {
        hold(decision.tasks, tasks, routed);
        hold(decision.reviews, reviews, routed);

        return finish(decision, force, tasks, reviews);
    }

    for (const task of tasks) {
        const refusal = taskRefusal(task, automation.filters ?? {}, inbox, handled);

        if (refusal) {
            decision.tasks.held.push({ item: task, reason: refusal });
        } else {
            decision.tasks.eligible.push(task);
        }
    }

    // Reviews ride on the same switch rather than one of their own. Answering a
    // review is work somebody is waiting on, and a config that says "you may
    // work on Demo development tasks between 8 and midnight" plainly means the
    // reviews of them too.
    if (automation.filters?.include_reviews === false) {
        hold(decision.reviews, reviews, 'filters.include_reviews is false');
    } else {
        decision.reviews.eligible = reviews;
    }

    return finish(decision, force, tasks, reviews);
}

/**
 * A task the board says a person has to look at first.
 *
 * Set in Cheto by whoever wrote the task, not in `cheto.yml`. The automation
 * policy lives on this machine and always will; this is the one thing the work
 * itself gets to say about it, and it only ever makes a pass more
 * conservative — a task that says nothing is an ordinary task.
 *
 * Released by acceptance rather than by a flag. Accepting is a deliberate act
 * on this specific task, which is exactly what "somebody has to look at it"
 * asked for; `cheto task accept <id>` is a person doing it from a terminal, and
 * the panel is a person doing it in a browser. The bridge never auto-accepts
 * work it is holding, so there is no loop back to itself.
 */
function needsAPerson(task) {
    return task?.requires_human === true && !task.accepted_at;
}

const NEEDS_A_PERSON = 'the board says a person has to look at this first — accept it to release it';

/** Work an explicit `--run` releases, and the final wake/scope answer. */
function finish(decision, force, tasks, reviews) {
    if (force) {
        // A person typed this. Their machine, their call — but it is recorded
        // as an override rather than quietly looking like ordinary policy.
        //
        // Except the tasks the board marked for a person. `--run` is somebody
        // saying "go" about this pass; it is not somebody saying they have read
        // TASK-42. Those two are not the same statement and only one of them
        // was asked for.
        const releasable = tasks.filter((task) => !needsAPerson(task));

        decision.tasks = {
            eligible: releasable,
            held: tasks.filter(needsAPerson).map((task) => ({ item: task, reason: NEEDS_A_PERSON })),
        };
        decision.reviews = { eligible: reviews, held: [] };
        decision.chat.allowed = decision.chat.items.length > 0;
        decision.notices.push('--run given: policy overridden for this pass.');

        if (releasable.length < tasks.length) {
            decision.notices.push('Some work is marked for a person and stays held: --run does not answer for them.');
        }
    }

    const hasWork = decision.tasks.eligible.length > 0 || decision.reviews.eligible.length > 0;

    decision.scope = hasWork && decision.chat.allowed ? 'both' : hasWork ? 'work' : decision.chat.allowed ? 'chat' : null;
    decision.wake = decision.scope !== null;

    if (decision.wake && !decision.runtimeConfigured) {
        decision.notices.push('No runtime configured in cheto.yml — the prompt is printed instead of run.');
    }

    return decision;
}

function hold(bucket, items, reason) {
    bucket.eligible = [];
    bucket.held = items.map((item) => ({ item, reason }));
}

/**
 * Everything that counts as somebody addressing this agent.
 *
 * Chat mentions come back as message rows. A mention inside a task comment
 * arrives as a notification instead, because comments are not channel messages
 * — different table, same intent, so both land here.
 */
function collectChat(inbox) {
    const mentions = (inbox.mentions ?? []).map((message) => ({
        kind: 'mention',
        id: message.id,
        channel: message.channel?.name ?? message.channel?.slug ?? null,
        author: message.author?.name ?? 'someone',
        body: message.body ?? '',
    }));

    const replies = (inbox.notifications ?? [])
        .filter((notification) => CHAT_NOTIFICATIONS.has(notification.key))
        .map((notification) => ({
            kind: 'notification',
            id: notification.id,
            key: notification.key,
            task: notification.parameters?.task ?? null,
            author: notification.parameters?.actor ?? 'someone',
            body:
                notification.key === 'notifications.cheto.task_comment_mentioned'
                    ? 'named you in a comment'
                    : 'commented on your task',
        }));

    return [...mentions, ...replies];
}

/**
 * Which runtime this work was meant for.
 *
 * Not every connected agent should see every task. When the config names an
 * agent, a machine acting as somebody else stays out of it — so Demo's search
 * tasks can go to `@indexer` without `@builder` racing it to them.
 */
function routingMismatch(notify, inbox) {
    const target = typeof notify === 'string' ? notify : notify?.agent;

    if (!target) {
        return null;
    }

    const wanted = String(target).replace(/^@/, '').toLowerCase();
    const actual = [inbox.agent?.handle, inbox.agent?.slug, inbox.agent?.name]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());

    return actual.includes(wanted) ? null : `routed to @${wanted}, this runtime is @${actual[0] ?? 'unknown'}`;
}

/** Why this particular task may not run, or null if it may. */
function taskRefusal(task, filters, inbox, handled) {
    // Before every filter, because no filter can lift it.
    if (needsAPerson(task)) {
        return NEEDS_A_PERSON;
    }

    const statuses = list(filters.statuses);

    if (statuses && !statuses.includes(String(task.status?.value).toLowerCase())) {
        return `status is ${task.status?.value}, not in [${statuses.join(', ')}]`;
    }

    const priorities = list(filters.priorities);

    if (priorities && !priorities.includes(String(task.priority?.value).toLowerCase())) {
        return `priority is ${task.priority?.value}, not in [${priorities.join(', ')}]`;
    }

    // Two different groupings, and they stopped being the same thing when tags
    // arrived. A channel is where work is discussed; a tag is what a workspace
    // decided to call it. `tags:` used to be accepted as a synonym for
    // `channels:` because there was nothing else to point it at — that is no
    // longer true, and a config written under the old reading now filters on
    // tags, which is what it said.
    const channels = list(filters.channels);

    if (channels) {
        const slug = String(task.channel?.slug ?? '').toLowerCase();

        if (!channels.includes(slug)) {
            return slug === ''
                ? `no channel, and filters name [${channels.join(', ')}]`
                : `channel is #${slug}, not in [${channels.join(', ')}]`;
        }
    }

    const tags = list(filters.tags);

    if (tags) {
        const carried = (task.tags ?? []).map((tag) => String(tag.slug ?? '').toLowerCase());
        // Every one, not any: two filters mean the tasks that are both, which
        // is what somebody naming two of them expects.
        const missing = tags.filter((tag) => !carried.includes(tag));

        if (missing.length > 0) {
            return carried.length === 0
                ? `no tags, and filters name [${tags.join(', ')}]`
                : `tagged [${carried.join(', ')}], missing [${missing.join(', ')}]`;
        }
    }

    // "project" in the product sense. In Cheto a workspace is the project, and
    // the credential already pins it — this filter is for a config shared
    // across machines that connect to more than one.
    const workspaces = list(filters.workspaces ?? filters.projects);

    if (workspaces && !workspaces.includes(String(inbox.workspace?.slug ?? '').toLowerCase())) {
        return `workspace is ${inbox.workspace?.slug}, not in [${workspaces.join(', ')}]`;
    }

    // Default true, and deliberately: acting on work nobody handed you is the
    // behaviour that needs the explicit opt-out, not the one that needs a flag.
    if (filters.assignment?.only_assigned_to_me !== false) {
        const mine = task.assignee?.type === 'agent' && task.assignee?.id === inbox.agent?.id;

        if (!mine) {
            return 'not assigned to this agent';
        }
    }

    // Already handed over, and unchanged since. Without this the same task is
    // rediscovered on every poll and re-planned forever — the failure the
    // review flow was built to make visible, arriving through the front door.
    const fingerprint = fingerprintOf(task);

    if (handled(task.id) === fingerprint) {
        return 'already handed to the runtime, and unchanged since';
    }

    return null;
}

/**
 * What "the same task, unchanged" means.
 *
 * `updated_at` moves whenever anything about the task does — a new comment, a
 * status change, a reassignment — so a task that genuinely progressed comes
 * back, and one that merely sat there does not.
 */
export function chatKey(item) {
    return `chat:${item.kind}:${item.id}`;
}

/**
 * What the ledger stores when a task was only *reported*, not handed over.
 *
 * Prefixed so it cannot be mistaken for a handover: `auto` compares against the
 * bare fingerprint, so a task this machine merely mentioned is still executed
 * the day somebody turns automation on.
 */
export function toldKey(task) {
    return `told:${fingerprintOf(task)}`;
}

/** A review's identity in the ledger. Its own namespace, so ids cannot collide. */
export function reviewKey(review) {
    return `review:${review?.id ?? ''}`;
}

export function fingerprintOf(task) {
    return `${task.updated_at ?? ''}|${task.status?.value ?? ''}|${task.accepted_at ?? ''}`;
}

function list(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const items = (Array.isArray(value) ? value : [value]).map((item) => String(item).replace(/^[@#]/, '').toLowerCase());

    return items.length > 0 ? items : null;
}

function normaliseMode(value) {
    if (value === undefined || value === null || value === '') {
        return DEFAULT_MODE;
    }

    const mode = String(value).toLowerCase();

    if (!MODES.includes(mode)) {
        throw new Error(`cheto.yml: mode "${value}" is not one of ${MODES.join(', ')}`);
    }

    return mode;
}
