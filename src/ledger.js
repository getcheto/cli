/**
 * What this machine has already handed to its runtime.
 *
 * A poll every thirty minutes finds the same task every time. Without a memory
 * of what it already passed along, an agent in `auto` mode re-reads, re-plans
 * and re-comments on work it started an hour ago — which looks like diligence
 * and is actually a loop.
 *
 * Knot's own fields answer most of this already: a task in Review is not
 * actionable, and an accepted task is no longer an offer. What they cannot
 * answer is "did *this machine* already act on this", because two runtimes may
 * share one membership. So it is recorded here, locally, next to the config
 * that authorised the run — not on the server, where it would become a shared
 * fact about an identity rather than a local one about a laptop.
 *
 * Losing this file is harmless: the worst case is one task handed over twice,
 * which is why it is a plain JSON file and not a database.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_HOME } from './credentials.js';

/** Enough for months of a busy workspace, small enough to rewrite whole. */
const MAX_ENTRIES = 500;

/**
 * Per Knot **and** per agent.
 *
 * Per Knot so a machine talking to staging and production does not carry one's
 * task ids into the other. Per agent because a machine runs several, and "this
 * machine already handled TASK-9" is a different fact for each of them: the
 * reviewer has not seen what the implementer was handed.
 */
function pathFor(url, handle) {
    const key = String(url ?? 'default').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const who = String(handle ?? 'default').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

    return join(CONFIG_HOME, `handled-${key}-${who}.json`);
}

export async function loadLedger(url, handle) {
    try {
        const parsed = JSON.parse(await readFile(pathFor(url, handle), 'utf8'));

        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        // Missing, unreadable or corrupt all mean the same thing here: this
        // machine remembers nothing. That is a safe state, not an error.
        return {};
    }
}

export async function saveLedger(url, handle, ledger) {
    const entries = Object.entries(ledger);
    const trimmed = entries.length > MAX_ENTRIES ? Object.fromEntries(entries.slice(-MAX_ENTRIES)) : ledger;

    try {
        await mkdir(CONFIG_HOME, { recursive: true });
        await writeFile(pathFor(url, handle), JSON.stringify(trimmed, null, 2), { mode: 0o600 });
    } catch {
        // A machine that cannot write its ledger should still do the work. It
        // will simply offer the same task again next time.
    }
}
