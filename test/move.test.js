/**
 * Where a card goes when somebody names a column.
 *
 * These are here rather than in the Laravel suite because what they exercise
 * is local: turning the words a person typed into the fields the API takes,
 * and reading the answer honestly. The server's own rules — who may move what,
 * and the refusal to close work — are tested where they live.
 *
 * The one worth keeping is the last group. `cheto task move` was written for a
 * failure that was silent: a field that validated, a 200, and a card that never
 * moved. A client that reports success on the strength of a 2xx reproduces
 * exactly that one layer up, so `reportMove` compares what came back against
 * what was asked for and says when they differ.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveFor, reportMove } from '../src/cli.js';

const MARKETING = {
    id: 16,
    name: 'Marketing & Reels',
    slug: 'marketing-reels',
    statuses: [
        { id: 77, name: 'Backlog ideas', key: 'inbox', category: { value: 'inbox' } },
        { id: 78, name: 'Aprobadas pendientes', key: 'ready', category: { value: 'ready' } },
        { id: 79, name: 'En producción', key: 'in_progress', category: { value: 'in_progress' } },
        { id: 80, name: 'Realizados — A postear', key: 'review', category: { value: 'review' } },
        { id: 81, name: 'Posteados', key: 'done', category: { value: 'done' } },
        { id: 116, name: 'Blocked', key: 'blocked', category: { value: 'in_progress' } },
    ],
};

const apiWith = (boards = [MARKETING]) => ({ areas: async () => boards });
const onBoard = (overrides = {}) => ({ id: 429, key: 'MKT-12', work_area_id: 16, ...overrides });

describe('naming a column', () => {
    it('sends that exact column, and the status it means', async () => {
        const body = await moveFor(apiWith(), onBoard(), 'Realizados — A postear');

        assert.deepEqual(body, { work_area_status_id: 80, status: 'review' });
    });

    it('tells apart two columns that mean the same thing', async () => {
        // The whole reason the column is sent at all. By category alone both
        // of these are "in progress", and a move by status lands on whichever
        // comes first — which is the wrong one half the time.
        const blocked = await moveFor(apiWith(), onBoard(), 'Blocked');
        const producing = await moveFor(apiWith(), onBoard(), 'En producción');

        assert.equal(blocked.work_area_status_id, 116);
        assert.equal(producing.work_area_status_id, 79);
        assert.equal(blocked.status, producing.status);
    });

    it('does not care about case, and takes the column key too', async () => {
        assert.equal((await moveFor(apiWith(), onBoard(), 'realizados — a postear')).work_area_status_id, 80);
        assert.equal((await moveFor(apiWith(), onBoard(), 'in_progress')).work_area_status_id, 79);
    });

    it('lists what the board does have when the name is wrong', async () => {
        await assert.rejects(() => moveFor(apiWith(), onBoard(), 'Shipped'), /no column called "Shipped".*Backlog ideas/s);
    });
});

describe('naming one of the five states', () => {
    it("resolves to that board's column when one matches by key", async () => {
        assert.deepEqual(await moveFor(apiWith(), onBoard(), 'review'), { work_area_status_id: 80, status: 'review' });
    });

    it('still works for a task on no board at all', async () => {
        assert.deepEqual(await moveFor(apiWith(), onBoard({ work_area_id: null }), 'review'), { status: 'review' });
    });

    it('refuses a column name for a task on no board, rather than guessing', async () => {
        await assert.rejects(
            () => moveFor(apiWith(), onBoard({ work_area_id: null }), 'Realizados — A postear'),
            /not on any board/,
        );
    });

    it('falls back to the five states when the board is not visible to this credential', async () => {
        assert.deepEqual(await moveFor(apiWith([]), onBoard(), 'review'), { status: 'review' });
        await assert.rejects(() => moveFor(apiWith([]), onBoard(), 'Blocked'), /cannot see the board/);
    });
});

describe("the refusal that is not this command's to relax", () => {
    it('will not move work into a done column, whatever it is called', async () => {
        // Area 16 renamed Done to "Posteados". A team's vocabulary is not a
        // way around the rule, and an agent that found one would believe it
        // had closed its own work.
        await assert.rejects(() => moveFor(apiWith(), onBoard(), 'Posteados'), /may never close its own work/);
    });

    it('says what to do instead, because a bare refusal gets retried', async () => {
        await assert.rejects(() => moveFor(apiWith(), onBoard(), 'Posteados'), /review/i);
    });
});

describe('reading the answer honestly', () => {
    const landedIn = (column) => ({
        key: 'MKT-12',
        title: 'Four reels',
        status: { value: 'in_progress' },
        board_status: column,
    });

    it('is happy when the card is where it was sent', () => {
        const code = reportMove(landedIn({ id: 116, name: 'Blocked' }), { work_area_status_id: 116 }, 'Blocked');

        assert.equal(code, 0);
    });

    it('fails when the card landed a column over', () => {
        // What an older Cheto does: it moves by what a column means rather
        // than by which one it is, so an exact move lands on the first column
        // of that meaning. Reporting success here is the original bug wearing
        // a client's clothes.
        const code = reportMove(landedIn({ id: 79, name: 'En producción' }), { work_area_status_id: 116 }, 'Blocked');

        assert.equal(code, 1);
    });

    it('claims nothing about the column when the server does not say', () => {
        const code = reportMove({ key: 'MKT-12', status: { value: 'review' } }, { work_area_status_id: 80 }, 'review');

        assert.equal(code, 0);
    });
});
