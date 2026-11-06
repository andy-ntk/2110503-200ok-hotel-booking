const DAY_IN_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

let clockFn = () => new Date();

const setClock = (fn) => {
    clockFn = typeof fn === 'function' ? fn : () => new Date();
};

const resetClock = () => {
    clockFn = () => new Date();
};

const getNow = () => clockFn();

const parseBookingDate = (value) => {
    if (value instanceof Date || value === null || value === undefined) {
        return value;
    }

    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('Date must use YYYY-MM-DD format');
    }

    const date = new Date(`${value}T00:00:00.000Z`);

    if (
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
    ) {
        throw new Error('Date must be a valid calendar date');
    }

    return date;
};

const isCalendarDate = (value) => {
    return (
        value instanceof Date &&
        Number.isFinite(value.getTime()) &&
        value.getTime() % DAY_IN_MS === 0
    );
};

const formatDateYMD = (date) => {
    return date.toISOString().slice(0, 10);
};

const getBangkokTodayDate = (now = getNow()) => {
    const currentMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const bangkokShifted = new Date(currentMs + BANGKOK_OFFSET_MS);
    const ymd = bangkokShifted.toISOString().slice(0, 10);
    return new Date(`${ymd}T00:00:00.000Z`);
};

const enumerateStayDates = (checkIn, checkOut) => {
    const start = parseBookingDate(checkIn);
    const end = parseBookingDate(checkOut);

    if (!isCalendarDate(start) || !isCalendarDate(end) || end <= start) {
        throw new Error('Invalid stay date range');
    }

    const dates = [];
    for (let ms = start.getTime(); ms < end.getTime(); ms += DAY_IN_MS) {
        dates.push(new Date(ms));
    }
    return dates;
};

module.exports = {
    DAY_IN_MS,
    parseBookingDate,
    isCalendarDate,
    formatDateYMD,
    getBangkokTodayDate,
    enumerateStayDates,
    setClock,
    resetClock,
    getNow
};
