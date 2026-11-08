const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnalyticsRange, buildDailyRows } = require('../services/analyticsService');
const { enumerateStayDates, parseBookingDate } = require('../utils/date');

test('analytics range is inclusive, accepts 31 days and leap days', () => {
    const range = parseAnalyticsRange('2026-01-01', '2026-01-31');
    assert.equal(range.endExclusive.toISOString(), '2026-02-01T00:00:00.000Z');
    assert.equal(parseAnalyticsRange('2028-02-29', '2028-02-29').start.toISOString(), '2028-02-29T00:00:00.000Z');
});

test('analytics rejects missing, invalid, reversed and overly long date ranges', () => {
    for (const [from, to] of [
        [undefined, '2026-01-01'], ['2026-01-01', undefined],
        ['2026-02-29', '2026-03-01'], ['2026-01-02', '2026-01-01'],
        ['2026-01-01', '2026-02-01'], [['2026-01-01'], '2026-01-02'],
        ['2026-01-01T00:00:00Z', '2026-01-02']
    ]) {
        assert.throws(() => parseAnalyticsRange(from, to), (err) => err.statusCode === 400);
    }
});

test('daily rows preserve nightly revenue, inactive types, zero nights and occupancy precision', () => {
    const dates = enumerateStayDates('2026-11-06', '2026-11-09');
    const types = [
        { _id: 'standard', name: 'Standard', totalCapacity: 3, active: true },
        { _id: 'suite', name: 'Suite', totalCapacity: 2, active: false }
    ];
    const totals = [
        { _id: { roomType: 'standard', date: parseBookingDate('2026-11-06') }, bookedRooms: 1, revenueSatang: 90000 },
        { _id: { roomType: 'standard', date: parseBookingDate('2026-11-07') }, bookedRooms: 2, revenueSatang: 228000 },
        { _id: { roomType: 'suite', date: parseBookingDate('2026-11-07') }, bookedRooms: 1, revenueSatang: 240000 }
    ];
    const rows = buildDailyRows(dates, types, totals);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[0], {
        date: '2026-11-06', roomType: { id: 'standard', name: 'Standard' }, capacity: 3,
        bookedRooms: 1, availableRooms: 2, occupancyRate: 33.33, revenueSatang: 90000
    });
    assert.equal(rows[2].occupancyRate, 66.67);
    assert.equal(rows[2].revenueSatang, 228000);
    assert.equal(rows[3].roomType.name, 'Suite');
    assert.equal(rows[3].occupancyRate, 50);
    assert.deepEqual(rows.slice(4).map(({ bookedRooms, revenueSatang }) => [bookedRooms, revenueSatang]), [[0, 0], [0, 0]]);
});
