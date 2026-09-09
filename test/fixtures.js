/** Inbox payloads shaped like the real `GET /api/v1/agent/inbox` response. */

export const AGENT = { id: 7, name: 'Builder', handle: 'builder', slug: 'builder' };

export function task(overrides = {}) {
    return {
        id: 42,
        key: 'TASK-42',
        title: 'Ship the thing',
        description: null,
        status: { value: 'ready' },
        priority: { value: 'normal' },
        assignee: { type: 'agent', id: AGENT.id, name: AGENT.name },
        channel: { slug: 'development', name: 'development' },
        tags: [{ id: 1, name: 'development', slug: 'development' }],
        accepted_at: null,
        is_offered: true,
        // The board's own veto on automation. False is the ordinary case, and
        // a fixture that defaulted it true would make every other test in here
        // secretly about this one field.
        requires_human: false,
        updated_at: '2026-09-09T12:00:00+00:00',
        allowed_transitions: ['inbox', 'in_progress'],
        ...overrides,
    };
}

export function inbox({ tasks = [], mentions = [], reviews = [], notifications = [], workspace = 'demo' } = {}) {
    return {
        agent: AGENT,
        workspace: { id: 1, slug: workspace, name: workspace },
        mentions,
        assigned_tasks: tasks,
        review_requests: reviews,
        notifications,
        cursor: '1:0:x:0',
        summary: {
            mentions: mentions.length,
            assigned_tasks: tasks.length,
            review_requests: reviews.length,
            unread_notifications: notifications.length,
            offers: tasks.filter((item) => item.accepted_at === null).length,
            has_work: mentions.length > 0 || tasks.length > 0 || reviews.length > 0,
        },
    };
}

export function mention(body, author = 'Diego search') {
    return { id: 1, body, author: { name: author }, channel: { slug: 'general', name: 'general' } };
}

/** A runtime is configured, so "did it wake" is about policy and not setup. */
export const RUNTIME = { type: 'command', command: 'claude', args: ['-p'] };

export const AUTO_CONFIG = {
    runtime: RUNTIME,
    mode: 'auto',
    automation: {
        tasks: {
            enabled: true,
            schedule: { timezone: 'America/Argentina/Buenos_Aires', from: '08:00', until: '23:59' },
            notify: { agent: 'builder' },
            filters: {
                statuses: ['inbox', 'ready'],
                channels: ['development'],
                tags: ['development'],
                projects: ['demo'],
                assignment: { only_assigned_to_me: true },
            },
        },
    },
};

/** Midday and 3am in Buenos Aires, as instants. */
export const MIDDAY = new Date('2026-09-09T15:00:00Z');
export const THREE_AM = new Date('2026-09-09T06:00:00Z');
