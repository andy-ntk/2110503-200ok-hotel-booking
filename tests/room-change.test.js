const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const RoomInventory = require('../models/RoomInventory');
const { changeRoomType } = require('../controllers/bookings');
const { setClock, resetClock, parseBookingDate } = require('../utils/date');

const ids = Array.from({ length: 5 }, (_, i) => new mongoose.Types.ObjectId(`67000000000000000000000${i + 1}`));
const [hotel, user, bookingId, source, target] = ids;
const query = (value) => ({
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); }
});
const response = () => ({ status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });

function setup(t, { owner = user.toString(), role = 'user', roomType = target.toString() } = {}) {
    setClock(() => new Date('2026-11-05T16:59:59Z'));
    t.after(resetClock);
    const calls = [];
    const booking = {
        hotel, user, roomType: source, checkIn: parseBookingDate('2026-11-06'),
        checkOut: parseBookingDate('2026-11-07'), totalPriceSatang: 100000,
        set(values) { Object.assign(this, values); },
        async save() { calls.push('save'); }
    };
    const session = {
        startTransaction() {}, inTransaction: () => true,
        async commitTransaction() {}, async abortTransaction() { calls.push('abort'); }, async endSession() {}
    };
    t.mock.method(mongoose, 'startSession', async () => session);
    t.mock.method(Hotel, 'findByIdAndUpdate', async () => ({ _id: hotel }));
    let reads = 0;
    t.mock.method(Booking, 'findOne', () => ++reads === 1 ? Promise.resolve(booking) : query(booking));
    t.mock.method(RoomType, 'findById', () => query({ hotel, active: true, totalCapacity: 1, basePriceSatang: 200000 }));
    t.mock.method(RoomInventory, 'find', () => query([]));
    t.mock.method(RoomInventory, 'findOneAndUpdate', async () => { calls.push('reserve'); return { bookedRooms: 1 }; });
    t.mock.method(RoomInventory, 'findOne', () => query({ bookedRooms: 1, async save() { calls.push('release'); } }));
    const req = { params: { id: bookingId.toString() }, user: { id: owner, role }, body: { roomType } };
    return { req, res: response(), booking, calls };
}

test('room change quotes the new type and reserves/releases in the same transaction', async (t) => {
    const { req, res, calls } = setup(t);
    await changeRoomType(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.previousTotalPriceSatang, 100000);
    assert.equal(res.body.data.newTotalPriceSatang, 200000);
    assert.equal(res.body.data.priceDifferenceSatang, 100000);
    assert.deepEqual(calls, ['reserve', 'release', 'save']);
});

test('same room type is a no-op preserving the booked price', async (t) => {
    const { req, res, calls } = setup(t, { roomType: source.toString().toUpperCase() });
    await changeRoomType(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.priceDifferenceSatang, 0);
    assert.equal(res.body.data.newTotalPriceSatang, 100000);
    assert.deepEqual(calls, []);
});

test('room change rejects another owner before mutating inventory', async (t) => {
    const { req, res, calls } = setup(t, { owner: target.toString() });
    await changeRoomType(req, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(calls, ['abort']);
});

test('room change closes exactly at midnight Bangkok, including same-type requests', async (t) => {
    const { req, res, calls } = setup(t, { roomType: source.toString() });
    setClock(() => new Date('2026-11-05T17:00:00Z'));
    await changeRoomType(req, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'CHECK_IN_STARTED');
    assert.deepEqual(calls, ['abort']);
});

test('room change accepts admin and reports a negative difference on downgrade', async (t) => {
    const { req, res, booking } = setup(t, { owner: target.toString(), role: 'admin' });
    booking.totalPriceSatang = 300000;
    await changeRoomType(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.priceDifferenceSatang, -100000);
});

test('room change rejects malformed IDs and extra price fields', async () => {
    for (const body of [{}, { roomType: 'bad' }, { roomType: target.toString(), totalPriceSatang: 1 }, null, []]) {
        const res = response();
        await changeRoomType({ params: { id: bookingId.toString() }, body }, res);
        assert.equal(res.statusCode, 400);
    }
});
