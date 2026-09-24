import { ChetoError } from './api.js';

/**
 * `--points 5`, or `none` to clear the estimate.
 *
 * Anything else stops the command. `Number('abc')` is NaN, JSON turns NaN into
 * null, and null clears the estimate — so a typo used to wipe it in silence.
 */
export function pointsFrom(value) {
    if (['none', 'null'].includes(String(value).toLowerCase())) {
        return null;
    }

    const points = Number(value);

    if (!Number.isInteger(points) || points < 0 || points > 100) {
        throw new ChetoError(`--points takes a whole number from 0 to 100, or none (got "${value}").`);
    }

    return points;
}
