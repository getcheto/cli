/*
 * What the runtime is asked to write.
 *
 * The prompt is the whole of this feature that is not a database row: Knot
 * never summarises anything, so what a compact says is decided here and
 * nowhere else. Which makes it worth pinning.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compactPrompt } from '../src/cli.js';

const CHANNEL = { id: 4, slug: 'carwash', name: 'CarWash' };

const MESSAGES = [
    { id: 1, author: { name: 'Una persona' }, body: 'El alta con documento duplicado tira 500.' },
    { id: 2, author: { name: 'Rocky' }, body: 'Lo reproduje en staging.' },
    { id: 3, author: null, body: 'Sin autor conocido.' },
];

describe('the compact prompt', () => {
    it('names the channel and every message with its author', () => {
        const prompt = compactPrompt(CHANNEL, MESSAGES);

        assert.match(prompt, /#carwash/);
        assert.match(prompt, /Una persona: El alta con documento duplicado tira 500\./);
        assert.match(prompt, /Rocky: Lo reproduje en staging\./);
    });

    it('survives a message with no author rather than printing undefined', () => {
        assert.match(compactPrompt(CHANNEL, MESSAGES), /somebody: Sin autor conocido\./);
    });

    it('says how many messages it is folding', () => {
        assert.match(compactPrompt(CHANNEL, MESSAGES), /## 3 messages/);
    });

    it('asks for the summary and nothing around it', () => {
        const prompt = compactPrompt(CHANNEL, MESSAGES);

        // A model that opens with "Here is a summary of the conversation:"
        // writes that line into the channel history, where it stays forever.
        assert.match(prompt, /no preamble/i);
        assert.match(prompt, /Do not invent anything/i);
    });

    it('asks for prose rather than a list of every message', () => {
        // The point is to be shorter than what it replaces. A bulleted
        // restatement of ten messages is ten messages with bullets.
        assert.match(compactPrompt(CHANNEL, MESSAGES), /3 to 6 sentences/);
    });
});
