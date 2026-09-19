/**
 * The Cheto API client.
 *
 * Deliberately thin: it adds a bearer header, parses JSON, and turns a failure
 * into an error a human can read. Everything else — what to call, in what
 * order — is the caller's business.
 *
 * `fetch` is built into Node 20, so this file has no dependencies. That is not
 * frugality for its own sake: a bridge somebody has to `npm install` before
 * their agent can talk to Cheto is a bridge with an install step, and the whole
 * point is that Cheto does not require one.
 */

export class ChetoError extends Error {
    constructor(message, { status = 0, body = null } = {}) {
        super(message);
        this.name = 'ChetoError';
        this.status = status;
        this.body = body;
    }

    /**
     * Whether trying again could plausibly work.
     *
     * 401 and 403 are decisions, not accidents: a revoked credential does not
     * become valid because you asked twice, and retrying a refusal is how a
     * loop turns a mistake into a rate-limit ban.
     */
    get retryable() {
        return this.status === 0 || this.status === 429 || this.status >= 500;
    }
}

export class ChetoApi {
    constructor({ url, token, fetchImpl = globalThis.fetch }) {
        this.base = `${String(url).replace(/\/+$/, '')}/api/v1/agent`;
        this.token = token;
        this.fetch = fetchImpl;
    }

    async request(path, { method = 'GET', body, form, idempotencyKey, timeoutMs = 30_000 } = {}) {
        const headers = { Accept: 'application/json' };

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        // A form gets no Content-Type from us on purpose: fetch has to write
        // it, because only fetch knows the multipart boundary it generated.

        // Sent on every write the bridge retries. Without it, a response lost
        // on the way back turns one comment into two.
        if (idempotencyKey) {
            headers['Idempotency-Key'] = idempotencyKey;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let response;

        try {
            response = await this.fetch(`${this.base}${path}`, {
                method,
                headers,
                body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
                signal: controller.signal,
            });
        } catch (cause) {
            throw new ChetoError(`Could not reach Cheto at ${this.base}: ${cause.message}`, { status: 0 });
        } finally {
            clearTimeout(timer);
        }

        const text = await response.text();
        let parsed = null;

        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            // A non-JSON body from an API means something upstream answered
            // instead of Cheto — a proxy error page, usually. Say so rather
            // than reporting a parse failure.
            throw new ChetoError(
                `Cheto returned ${response.status} with a body that is not JSON. Is ${this.base} really a Cheto API?`,
                { status: response.status },
            );
        }

        if (!response.ok) {
            throw new ChetoError(parsed?.message ?? `Cheto returned ${response.status}`, {
                status: response.status,
                body: parsed,
            });
        }

        return parsed;
    }

    me() {
        return this.request('/me');
    }

    task(id) {
        return this.request(`/tasks/${id}`);
    }

    /** Say yes to work already assigned to you. Not the same call as claim. */
    accept(taskId, idempotencyKey) {
        return this.request(`/tasks/${taskId}/accept`, { method: 'POST', idempotencyKey });
    }

    claim(taskId, idempotencyKey) {
        return this.request(`/tasks/${taskId}/claim`, { method: 'POST', idempotencyKey });
    }

    heartbeat(status) {
        return this.request('/heartbeat', { method: 'POST', body: status ? { status } : {} });
    }

    /**
     * The inbox, optionally waiting for something to arrive.
     *
     * `waitSeconds` holds the connection open server-side until there is work
     * or the wait runs out — so a loop answers the moment a task is assigned
     * instead of on its next tick, over plain HTTP.
     */
    inbox({ waitSeconds = 0 } = {}) {
        const query = waitSeconds > 0 ? `?wait=${waitSeconds}` : '';

        // The request timeout has to outlast the server's wait, or the client
        // aborts a connection that was about to answer.
        return this.request(`/inbox${query}`, { timeoutMs: (waitSeconds + 15) * 1000 });
    }

    comment(taskId, body, idempotencyKey) {
        return this.request(`/tasks/${taskId}/comments`, { method: 'POST', body: { body }, idempotencyKey });
    }

    /**
     * Write something down.
     *
     * `work_area_id` is the field worth naming: without it a task lands on the
     * agent's own board if its membership has one, and on the workspace's first
     * board if not — which for an agent that works on one board and never says
     * so is how everything it writes ends up somewhere else.
     */
    createTask(body, idempotencyKey) {
        return this.request('/tasks', { method: 'POST', body, idempotencyKey });
    }

    /** The boards of this workspace, from the identity call that already lists them. */
    async areas() {
        return (await this.me()).areas ?? [];
    }

    /**
     * Say what a thing *is*. Not what should happen to it.
     *
     * The describing half of triage, which an agent may do; deciding it is
     * finished stays a 403 no permission grants.
     */
    setType(taskId, type, idempotencyKey) {
        return this.request(`/tasks/${taskId}`, { method: 'PATCH', body: { type }, idempotencyKey });
    }

    /**
     * Say where the work got to.
     *
     * The body is built by the caller because there are two ways to name a
     * destination — a column of the board, or one of the five states — and
     * which one is available depends on what the caller could see. See
     * `moveFor` in cli.js.
     */
    moveTask(taskId, body, idempotencyKey) {
        return this.request(`/tasks/${taskId}`, { method: 'PATCH', body, idempotencyKey });
    }

    /**
     * Everything older than the bounded read.
     *
     * The counterpart to `context`: an agent is handed a few compacts and a
     * handful of messages, and reaches past them with this rather than by
     * asking for a bigger window.
     */
    search(query, { kinds = [], limit = 0 } = {}) {
        const params = new URLSearchParams({ q: query });

        kinds.forEach((kind) => params.append('kind[]', kind));

        if (limit > 0) {
            params.set('limit', String(limit));
        }

        return this.request(`/search?${params.toString()}`);
    }

    // ── What the workspace knows ───────────────────────

    memories({ key = null, q = null } = {}) {
        const params = new URLSearchParams();

        if (key) params.set('key', key);
        if (q) params.set('q', q);

        return this.request(`/memory${params.size > 0 ? `?${params.toString()}` : ''}`);
    }

    writeMemory(body, idempotencyKey) {
        return this.request('/memory', { method: 'POST', body, idempotencyKey });
    }

    forgetMemory(id) {
        return this.request(`/memory/${id}`, { method: 'DELETE' });
    }

    // ── Channels and folding their history ─────────────

    channels() {
        return this.request('/channels');
    }

    /** The bounded read: a few compacts and the messages after them. */
    context(channel, messages) {
        return this.request(`/channels/${channel}/context${messages ? `?messages=${messages}` : ''}`);
    }

    /** Everything a fold would have to cover. Deliberately not bounded. */
    pendingCompact(channel) {
        return this.request(`/channels/${channel}/compacts/pending`);
    }

    postCompact(channel, body, idempotencyKey) {
        return this.request(`/channels/${channel}/compacts`, { method: 'POST', body: { body }, idempotencyKey });
    }

    post(channel, body, idempotencyKey) {
        return this.request(`/channels/${channel}/messages`, { method: 'POST', body: { body }, idempotencyKey });
    }

    markNotificationsRead(ids) {
        return this.request('/notifications/read', { method: 'POST', body: ids ? { ids } : {} });
    }

    static pair(url, code, body = {}, fetchImpl = globalThis.fetch) {
        const api = new ChetoApi({ url, token: null, fetchImpl });

        return api.request('/pair', { method: 'POST', body: { code, ...body } });
    }
}

/**
 * The human half.
 *
 * A separate client, on a separate prefix, holding a separate token — the same
 * separation the server keeps between its two guards. Sharing one client would
 * make it one refactor away from sending an agent credential to a route that
 * mints principals.
 */
export class ChetoUserApi {
    constructor({ url, token, fetchImpl = globalThis.fetch }) {
        this.base = `${String(url).replace(/\/+$/, '')}/api/v1/cli`;
        this.token = token;
        this.fetch = fetchImpl;
    }

    request(path, options = {}) {
        // Same transport, different prefix. ChetoApi's request() is written
        // against `this.base`, so borrowing it here is exact rather than
        // approximate.
        return ChetoApi.prototype.request.call(this, path, options);
    }

    me() {
        return this.request('/me');
    }

    agents() {
        return this.request('/agents');
    }

    createAgent(body) {
        return this.request('/agents', { method: 'POST', body });
    }

    updateAgent(agentId, body) {
        return this.request(`/agents/${agentId}`, { method: 'PATCH', body });
    }

    /** A picture, as multipart. The server never fetches a URL we hand it. */
    uploadAvatar(agentId, form) {
        return this.request(`/agents/${agentId}/avatar`, { method: 'POST', form });
    }

    join(agentId, body) {
        return this.request(`/agents/${agentId}/memberships`, { method: 'POST', body });
    }

    pair(membershipId) {
        return this.request(`/memberships/${membershipId}/pair`, { method: 'POST', body: {} });
    }

    disconnect(connectionId) {
        return this.request(`/connections/${connectionId}`, { method: 'DELETE' });
    }

    /** Begin `cheto login`. Unauthenticated: this is how a token is obtained. */
    static startLogin(url, machine, fetchImpl = globalThis.fetch) {
        const api = new ChetoUserApi({ url, token: null, fetchImpl });

        return api.request('/device', { method: 'POST', body: { machine } });
    }

    /**
     * Ask whether the person has approved yet.
     *
     * 428 is "not yet" and is not an error — the caller keeps waiting. Anything
     * else is a decision, and decisions do not change by asking again.
     */
    static async collect(url, deviceCode, fetchImpl = globalThis.fetch) {
        const api = new ChetoUserApi({ url, token: null, fetchImpl });

        try {
            return await api.request('/device/token', { method: 'POST', body: { device_code: deviceCode } });
        } catch (error) {
            if (error instanceof ChetoError && error.status === 428) {
                return null;
            }

            throw error;
        }
    }
}
