/**
 * When this machine is allowed to start work.
 *
 * A local policy, deliberately. Cheto does not decide when somebody's laptop is
 * allowed to run a model: the server has no idea that this machine is a work
 * laptop that closes at midnight, and encoding that on the Agent would make one
 * person's evening a property of a shared identity.
 *
 * `Intl` does the timezone arithmetic, so there is no dependency and no table
 * of offsets to go stale twice a year.
 */

/** No schedule configured means no restriction. Absence is not a closed door. */
export function isWithinSchedule(schedule, now = new Date()) {
    return describeSchedule(schedule, now).inside;
}

/**
 * The same answer, with the reasoning attached.
 *
 * Returned rather than logged, because "why did nothing happen at 3am" is the
 * question this whole module exists to answer, and it has to survive into a
 * report the person reads the next morning.
 */
export function describeSchedule(schedule, now = new Date()) {
    if (!schedule || (!schedule.from && !schedule.until)) {
        return { inside: true, configured: false, reason: 'no schedule configured' };
    }

    const timezone = schedule.timezone ?? null;
    const from = parseClock(schedule.from ?? '00:00', 'from');
    const until = parseClock(schedule.until ?? '23:59', 'until');

    let minutes;

    try {
        minutes = minutesInZone(now, timezone);
    } catch {
        // A misspelt zone must not silently become UTC and let a machine work
        // at hours nobody chose. Refuse instead, and say so.
        return {
            inside: false,
            configured: true,
            reason: `unknown timezone "${timezone}" — nothing will start until it is fixed`,
        };
    }

    // `00:00` as a closing time means the end of this day, not the start of it.
    // Written literally it would be a window of zero length, which is never
    // what "08:00 until 00:00" means to the person who wrote it.
    const close = until === 0 && from !== 0 ? 24 * 60 : until;

    // `until` is inclusive: it is the last minute at which work may *start*,
    // not a deadline for finishing. A task that begins at 23:59 runs as long as
    // it needs to; the window governs starting, and nothing here stops a
    // running agent mid-sentence.
    const inside =
        from === close
            ? true
            : from < close
              ? minutes >= from && minutes <= close
              : // Crossing midnight: 22:00 → 02:00 is two arcs of one window.
                minutes >= from || minutes <= close;

    const window = `${schedule.from ?? '00:00'}–${schedule.until ?? '23:59'}${timezone ? ` ${timezone}` : ''}`;

    return {
        inside,
        configured: true,
        window,
        localTime: formatClock(minutes),
        reason: inside ? `inside ${window}` : `outside ${window} — local time is ${formatClock(minutes)}`,
    };
}

/** `"08:30"` → 510. Anything else is an error, not a guess. */
function parseClock(value, label) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());

    if (!match) {
        throw new Error(`cheto.yml: schedule.${label} should look like "08:00", got "${value}"`);
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 24 || minutes > 59) {
        throw new Error(`cheto.yml: schedule.${label} "${value}" is not a time of day`);
    }

    return hours * 60 + minutes;
}

function formatClock(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Minutes past midnight where the person is, not where the server is. */
function minutesInZone(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        ...(timezone ? { timeZone: timezone } : {}),
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);

    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

    return hour * 60 + minute;
}
