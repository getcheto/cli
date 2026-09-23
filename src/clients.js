/**
 * Clients built from a session, and what a 401 does to the credential behind it.
 *
 * One place, because there are three ways to hold a credential here — an agent
 * paired on this machine, the person's own login, and the person's login
 * speaking as one of their agents — and the rule for each is the same shape:
 * a 401 means Cheto no longer recognises the token (revoked in the panel,
 * expired after its 90 days, or never real), so this machine forgets it and
 * says how to get a new one. Keeping a dead token would only turn every later
 * command into the same 401.
 *
 * Only 401. A 400, 403, 404 or 409 is about the request — the wrong agent name,
 * a missing scope, a task somebody else holds — and the credential is fine.
 * Forgetting it there would log a person out for a typo.
 */

import { ChetoApi, ChetoUserApi } from './api.js';
import { forgetAgent, forgetUserCredential } from './credentials.js';

const warn = (...args) => console.error(...args);

/** The agent API, as whichever agent the session names. */
export function apiFor(session) {
    return new ChetoApi({
        url: session.url,
        token: session.token,
        headers: session.headers ?? {},
        onUnauthorized: () => (session.via === 'user' ? forgetUser(session.url) : forgetPaired(session)),
    });
}

/** The human API, as the person signed in with `cheto login`. */
export function userApiFor(session) {
    return new ChetoUserApi({
        url: session.url,
        token: session.token,
        onUnauthorized: () => forgetUser(session.url),
    });
}

async function forgetUser(url) {
    try {
        await forgetUserCredential(url);
    } catch (error) {
        warn(`Could not remove the stored login: ${error.message}`);
    }

    return 'Your login on this machine was revoked or has expired, and has been removed. Run: cheto login';
}

async function forgetPaired(session) {
    try {
        await forgetAgent(session.url, session.handle);
    } catch (error) {
        warn(`Could not remove the stored credential: ${error.message}`);
    }

    return (
        `The credential for @${session.handle ?? '?'} was revoked or has expired, and has been removed from this machine. ` +
        'Re-pair it: get a code from the Agents page (or cheto agent pair <membership>), then cheto connect <code>.'
    );
}
