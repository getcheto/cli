import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeSchedule, isWithinSchedule } from '../src/schedule.js';

const BA = 'America/Argentina/Buenos_Aires';

describe('working hours', () => {
    it('has no opinion when nothing is configured', () => {
        assert.equal(isWithinSchedule(null), true);
        assert.equal(isWithinSchedule({ timezone: BA }), true);
    });

    it('is local time, not the server clock', () => {
        // 06:00 UTC is 03:00 in Buenos Aires, which is the whole point.
        const schedule = { timezone: BA, from: '08:00', until: '23:59' };

        assert.equal(isWithinSchedule(schedule, new Date('2026-09-09T06:00:00Z')), false);
        assert.equal(isWithinSchedule(schedule, new Date('2026-09-09T15:00:00Z')), true);
    });

    it('reads "until 00:00" as the end of the day, not a window of zero length', () => {
        const schedule = { timezone: BA, from: '08:00', until: '00:00' };

        assert.equal(isWithinSchedule(schedule, new Date('2026-09-10T02:00:00Z')), true); // 23:00 local
        assert.equal(isWithinSchedule(schedule, new Date('2026-09-09T06:00:00Z')), false); // 03:00 local
    });

    it('handles a window that crosses midnight', () => {
        const nightShift = { timezone: BA, from: '22:00', until: '02:00' };

        assert.equal(isWithinSchedule(nightShift, new Date('2026-09-10T02:00:00Z')), true); // 23:00
        assert.equal(isWithinSchedule(nightShift, new Date('2026-09-09T04:00:00Z')), true); // 01:00
        assert.equal(isWithinSchedule(nightShift, new Date('2026-09-09T18:00:00Z')), false); // 15:00
    });

    it('refuses a timezone it does not know rather than quietly using UTC', () => {
        const result = describeSchedule({ timezone: 'Mars/Olympus', from: '08:00', until: '10:00' });

        assert.equal(result.inside, false);
        assert.match(result.reason, /unknown timezone/);
    });

    it('explains itself, because "why did nothing run" is asked the next morning', () => {
        const result = describeSchedule({ timezone: BA, from: '08:00', until: '23:59' }, new Date('2026-09-09T06:00:00Z'));

        assert.match(result.reason, /outside 08:00–23:59/);
        assert.equal(result.localTime, '03:00');
    });

    it('will not accept a time it cannot read', () => {
        assert.throws(() => describeSchedule({ from: 'morning', until: '18:00' }), /should look like/);
    });
});
