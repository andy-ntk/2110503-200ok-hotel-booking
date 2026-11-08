process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-secret';
process.env.JWT_EXPIRE = process.env.JWT_EXPIRE || '1h';
process.env.JWT_COOKIE_EXPIRE = process.env.JWT_COOKIE_EXPIRE || '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const app = require('../server');
const User = require('../models/User');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const Booking = require('../models/Booking');
const RoomInventory = require('../models/RoomInventory');
const { setClock, resetClock, enumerateStayDates } = require('../utils/date');
const { assertTestDatabase } = require('../utils/testDatabase');

const uri = process.env.TEST_MONGO_URI;
test('HTTP integration: requirements 1-5 and booking permissions', {
    skip: !uri ? 'Set TEST_MONGO_URI to run integration tests' : false
}, async (t) => {
    assertTestDatabase(uri);
    let server;
    t.after(async () => {
        resetClock();
        if (server) await new Promise((resolve) => server.close(resolve));
        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.dropDatabase();
            await mongoose.disconnect();
        }
    });
    await mongoose.connect(uri);
    await Promise.all([User.init(), Hotel.init(), RoomType.init(), Booking.init(), RoomInventory.init()]);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;

    const request = async (method, path, token, body) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const expectStatus = (res, status) => {
        assert.equal(res.status, status, JSON.stringify(res.body));
        return res.body.data;
    };
    const day = (text) => new Date(`${text}T00:00:00Z`);
    const hotelData = (name) => ({ name, address: '123 Test Road', district: 'Test', province: 'Bangkok', postalcode: '10110', tel: '021234567' });

    async function seed() {
        for (const model of [Booking, RoomInventory, RoomType, Hotel, User]) await model.deleteMany({});
        setClock(() => new Date('2026-11-05T16:59:59Z'));
        const users = [];
        for (const [index, role] of ['user', 'user', 'admin'].entries()) {
            users.push(await User.create({
                name: `Guest ${index}`, phone: `080000000${index}`, email: `guest${index}@hotel.test`,
                password: 'password123', role
            }));
        }
        const [owner, other, admin] = users;
        const h1 = await Hotel.create(hotelData('Hotel One'));
        const h2 = await Hotel.create(hotelData('Hotel Two'));
        const standard = await RoomType.create({ hotel: h1._id, name: 'Standard', basePriceSatang: 100000, totalCapacity: 3 });
        const suite = await RoomType.create({ hotel: h1._id, name: 'Suite', basePriceSatang: 200000, totalCapacity: 2 });
        const retired = await RoomType.create({ hotel: h1._id, name: 'Retired', basePriceSatang: 50000, totalCapacity: 1, active: false });
        const foreign = await RoomType.create({ hotel: h2._id, name: 'Other Standard', basePriceSatang: 80000, totalCapacity: 3 });
        const c = { owner, other, admin, h1, h2, standard, suite, retired, foreign };
        c.ownerToken = owner.getSignedJwtToken();
        c.otherToken = other.getSignedJwtToken();
        c.adminToken = admin.getSignedJwtToken();
        c.book = async (fields = {}, token = c.ownerToken, hotel = h1) => expectStatus(
            await request('POST', `/hotels/${hotel.id}/bookings`, token, {
                roomType: standard.id, checkIn: '2026-11-06', checkOut: '2026-11-09', ...fields
            }), 201
        );
        c.change = (booking, target, token = c.ownerToken) => request('PATCH', `/bookings/${booking._id}/room-type`, token, { roomType: target.id });
        c.report = (query = 'from=2026-11-05&to=2026-11-10', token = c.adminToken, hotel = h1) =>
            request('GET', `/hotels/${hotel.id}/analytics?${query}`, token);
        return c;
    }

    async function assertInventoryMatchesBookings() {
        const expected = new Map();
        const types = new Map((await RoomType.find({}).lean()).map((type) => [type._id.toString(), type]));
        for (const booking of await Booking.find({}).lean()) {
            const nights = enumerateStayDates(booking.checkIn, booking.checkOut);
            assert.equal(booking.nightlyPrices.length, nights.length);
            assert.equal(booking.totalPriceSatang, booking.nightlyPrices.reduce((sum, n) => sum + n.amountSatang, 0));
            for (const date of nights) {
                const key = `${booking.hotel}:${booking.roomType}:${date.toISOString()}`;
                expected.set(key, (expected.get(key) || 0) + 1);
            }
        }
        for (const inventory of await RoomInventory.find({}).lean()) {
            const key = `${inventory.hotel}:${inventory.roomType}:${inventory.date.toISOString()}`;
            assert.equal(inventory.bookedRooms, expected.get(key) || 0, key);
            assert.ok(inventory.bookedRooms >= 0);
            assert.ok(inventory.bookedRooms <= types.get(inventory.roomType.toString()).totalCapacity);
            expected.delete(key);
        }
        assert.equal(expected.size, 0, 'Every booked night must have inventory');
    }
    const scenario = (name, run) => t.test(name, async (st) => {
        const c = await seed();
        await run(c, st);
        await assertInventoryMatchesBookings();
    });

    await scenario('core 1-3: registration/login/logout, hotel listing, valid and invalid booking dates', async (c) => {
        const registration = await request('POST', '/auth/register', undefined, {
            name: 'New Guest', phone: '0899999999', email: 'new@hotel.test', password: 'password123', role: 'admin'
        });
        assert.equal(registration.status, 200);
        assert.ok(registration.body.token);
        assert.equal((await User.findOne({ email: 'new@hotel.test' })).role, 'user');
        const login = await request('POST', '/auth/login', undefined, { email: 'new@hotel.test', password: 'password123' });
        assert.equal(login.status, 200);
        assert.equal((await request('POST', '/auth/login', undefined, { email: 'new@hotel.test', password: 'wrong' })).status, 401);
        const me = expectStatus(await request('GET', '/auth/me', login.body.token), 200);
        assert.equal(me.email, 'new@hotel.test');
        assert.equal(Object.hasOwn(me, 'password'), false);
        const logout = await request('GET', '/auth/logout', login.body.token);
        expectStatus(logout, 200);
        assert.match(logout.headers.get('set-cookie'), /token=none/);
        const hotels = expectStatus(await request('GET', '/hotels'), 200);
        assert.ok(hotels.some((hotel) => hotel.name === c.h1.name && hotel.address && hotel.tel));
        const booking = await c.book({}, login.body.token);
        assert.equal(booking.totalPriceSatang, 306000);
        for (const dates of [
            { checkIn: '2026-11-06', checkOut: '2026-11-06' },
            { checkIn: '2026-11-06', checkOut: '2026-11-10' },
            { checkIn: '2026-02-30', checkOut: '2026-03-01' }
        ]) expectStatus(await request('POST', `/hotels/${c.h1.id}/bookings`, c.ownerToken, { roomType: c.standard.id, ...dates }), 400);
        expectStatus(await request('POST', `/hotels/${c.h1.id}/bookings`, undefined, {}), 401);
    });

    await scenario('core 4-9: own booking visibility/edit/delete and admin controls', async (c) => {
        const own = await c.book();
        const other = await c.book({}, c.otherToken);
        assert.equal(expectStatus(await request('GET', '/bookings', c.ownerToken), 200).length, 1);
        assert.equal(expectStatus(await request('GET', '/bookings', c.adminToken), 200).length, 2);
        expectStatus(await request('GET', `/bookings/${other._id}`, c.ownerToken), 403);
        expectStatus(await request('GET', `/bookings/${own._id}`, c.ownerToken), 200);
        expectStatus(await request('PUT', `/bookings/${other._id}`, c.ownerToken, { checkOut: '2026-11-08' }), 403);
        expectStatus(await request('DELETE', `/bookings/${other._id}`, c.ownerToken), 403);
        expectStatus(await request('GET', `/hotels/${c.h2.id}/bookings/${own._id}`, c.adminToken), 404);
        expectStatus(await request('PUT', `/hotels/${c.h2.id}/bookings/${own._id}`, c.adminToken, { checkOut: '2026-11-08' }), 404);
        expectStatus(await request('DELETE', `/hotels/${c.h2.id}/bookings/${own._id}`, c.adminToken), 404);
        const updated = expectStatus(await request('PUT', `/bookings/${own._id}`, c.ownerToken, {
            checkIn: '2026-11-09', checkOut: '2026-11-10'
        }), 200);
        assert.equal(updated.totalPriceSatang, 100000);
        expectStatus(await request('DELETE', `/bookings/${own._id}`, c.ownerToken), 200);
        expectStatus(await request('GET', `/bookings/${other._id}`, c.adminToken), 200);
        expectStatus(await request('PUT', `/bookings/${other._id}`, c.adminToken, { checkOut: '2026-11-08' }), 200);
        expectStatus(await request('DELETE', `/bookings/${other._id}`, c.adminToken), 200);
        assert.equal(await Booking.countDocuments({}), 0);
    });

    await scenario('requirements 1-3: room type permissions, capacity reductions and inactive types', async (c) => {
        const fields = { name: 'Free', basePriceSatang: 0, totalCapacity: 1, amenities: ['WiFi'] };
        expectStatus(await request('POST', `/hotels/${c.h1.id}/room-types`, c.ownerToken, fields), 403);
        const free = expectStatus(await request('POST', `/hotels/${c.h1.id}/room-types`, c.adminToken, fields), 201);
        expectStatus(await request('GET', `/hotels/${c.h1.id}/room-types/${free._id}`), 200);
        assert.equal(expectStatus(await request('GET', `/hotels/${c.h1.id}/room-types`), 200).length, 4);
        const a = await c.book();
        await c.book({}, c.otherToken);
        expectStatus(await request('PUT', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.ownerToken, { totalCapacity: 1 }), 403);
        const below = await request('PUT', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.adminToken, { totalCapacity: 1 });
        expectStatus(below, 409);
        assert.equal(below.body.code, 'CAPACITY_BELOW_BOOKED');
        expectStatus(await request('PUT', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.adminToken, { totalCapacity: 2 }), 200);
        expectStatus(await request('DELETE', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.ownerToken), 403);
        expectStatus(await request('DELETE', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.adminToken), 200);
        assert.equal(expectStatus(await request('GET', `/hotels/${c.h1.id}/room-types/${c.standard.id}`), 200).active, false);
        expectStatus(await request('POST', `/hotels/${c.h1.id}/bookings`, c.ownerToken, {
            roomType: c.standard.id, checkIn: '2026-11-10', checkOut: '2026-11-11'
        }), 400);
        assert.equal(expectStatus(await c.change(a, c.standard), 200).priceDifferenceSatang, 0);
        expectStatus(await c.change(a, c.suite), 200);
    });

    await scenario('requirement 4: upgrades, downgrades, equal/zero prices and immutable no-op quote', async (c) => {
        const booking = await c.book();
        let result = expectStatus(await c.change(booking, c.suite), 200);
        assert.equal(result.previousTotalPriceSatang, 306000);
        assert.equal(result.newTotalPriceSatang, 612000);
        assert.equal(result.priceDifferenceSatang, 306000);
        result = expectStatus(await c.change(booking, c.standard), 200);
        assert.equal(result.priceDifferenceSatang, -306000);
        expectStatus(await request('PUT', `/hotels/${c.h1.id}/room-types/${c.standard.id}`, c.adminToken, { basePriceSatang: 150000 }), 200);
        result = expectStatus(await c.change(booking, { id: c.standard.id.toUpperCase() }), 200);
        assert.equal(result.newTotalPriceSatang, 306000);
        assert.equal(result.priceDifferenceSatang, 0);
        const equal = await RoomType.create({ hotel: c.h1._id, name: 'Equal price', basePriceSatang: 100000, totalCapacity: 1 });
        assert.equal(expectStatus(await c.change(booking, equal), 200).priceDifferenceSatang, 0);
        const free = await RoomType.create({ hotel: c.h1._id, name: 'Free', basePriceSatang: 0, totalCapacity: 1 });
        result = expectStatus(await c.change(booking, free), 200);
        assert.equal(result.newTotalPriceSatang, 0);
        assert.equal(result.priceDifferenceSatang, -306000);
    });

    await scenario('requirement 4: ownership, nested hotel scope and input validation', async (c) => {
        const booking = await c.book();
        expectStatus(await c.change(booking, c.suite, c.otherToken), 403);
        expectStatus(await request('PATCH', `/bookings/${booking._id}/room-type`, undefined, { roomType: c.suite.id }), 401);
        expectStatus(await request('PATCH', `/hotels/${c.h2.id}/bookings/${booking._id}/room-type`, c.adminToken, { roomType: c.suite.id }), 404);
        for (const body of [{}, [], { roomType: 'invalid' }, { roomType: c.suite.id, totalPriceSatang: 1 }, { roomType: c.suite.id, checkIn: '2026-11-01' }]) {
            expectStatus(await request('PATCH', `/bookings/${booking._id}/room-type`, c.ownerToken, body), 400);
        }
        expectStatus(await request('PATCH', '/bookings/invalid/room-type', c.ownerToken, { roomType: c.suite.id }), 400);
        expectStatus(await c.change({ _id: new mongoose.Types.ObjectId() }, c.suite), 404);
        expectStatus(await c.change(booking, { id: new mongoose.Types.ObjectId().toString() }), 404);
        expectStatus(await c.change(booking, c.foreign), 400);
        expectStatus(await c.change(booking, c.retired), 400);
        expectStatus(await request('PATCH', `/hotels/${c.h1.id}/bookings/${booking._id}/room-type`, c.ownerToken, { roomType: c.suite.id }), 200);
        expectStatus(await c.change(booking, c.standard, c.adminToken), 200);
        expectStatus(await request('PUT', `/bookings/${booking._id}`, c.ownerToken, { roomType: c.suite.id }), 400);
    });

    await scenario('requirement 4: exact Bangkok midnight cutoff applies to owner, admin and no-op', async (c) => {
        const booking = await c.book();
        expectStatus(await c.change(booking, c.suite), 200);
        const before = await Booking.findById(booking._id).lean();
        setClock(() => new Date('2026-11-05T17:00:00Z'));
        for (const [target, token] of [[c.standard, c.ownerToken], [c.suite, c.ownerToken], [c.standard, c.adminToken]]) {
            const res = await c.change(booking, target, token);
            expectStatus(res, 409);
            assert.equal(res.body.code, 'CHECK_IN_STARTED');
        }
        setClock(() => new Date('2026-11-08T12:00:00Z'));
        expectStatus(await c.change(booking, c.standard), 409);
        assert.deepEqual(await Booking.findById(booking._id).lean(), before);
    });

    await scenario('requirement 4: target full on one night rolls back booking and all source nights', async (c) => {
        const booking = await c.book();
        await c.book({ roomType: c.suite.id, checkIn: '2026-11-07', checkOut: '2026-11-08' }, c.otherToken);
        await c.book({ roomType: c.suite.id, checkIn: '2026-11-07', checkOut: '2026-11-08' }, c.adminToken);
        const beforeBooking = await Booking.findById(booking._id).lean();
        const beforeInventory = await RoomInventory.find({}).sort({ _id: 1 }).lean();
        const result = await c.change(booking, c.suite);
        expectStatus(result, 409);
        assert.equal(result.body.code, 'CAPACITY_FULL');
        assert.deepEqual(await Booking.findById(booking._id).lean(), beforeBooking);
        assert.deepEqual(await RoomInventory.find({}).sort({ _id: 1 }).lean(), beforeInventory);
    });

    await scenario('requirement 4: booking save failure rolls back target reserve and source release', async (c, st) => {
        const booking = await c.book();
        const before = await RoomInventory.find({}).sort({ _id: 1 }).lean();
        const originalSave = Booking.prototype.save;
        st.mock.method(Booking.prototype, 'save', async function (...args) {
            if (this.id === booking._id) throw new Error('Injected booking save failure');
            return originalSave.apply(this, args);
        });
        const result = await c.change(booking, c.suite);
        expectStatus(result, 500);
        assert.equal(result.body.message, 'Cannot change room type');
        assert.deepEqual(await RoomInventory.find({}).sort({ _id: 1 }).lean(), before);
        assert.equal((await Booking.findById(booking._id)).roomType.toString(), c.standard.id);
    });

    await scenario('requirement 4: two upgrades compete for one target room without overbooking', async (c) => {
        await RoomType.updateOne({ _id: c.suite._id }, { totalCapacity: 1 });
        const a = await c.book();
        const b = await c.book({}, c.otherToken);
        const results = await Promise.all([c.change(a, c.suite), c.change(b, c.suite, c.otherToken)]);
        assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
        assert.ok(['CAPACITY_FULL', 'TRANSACTION_CONFLICT'].includes(results.find((res) => res.status === 409).body.code));
        assert.equal(await Booking.countDocuments({ roomType: c.suite._id }), 1);
        assert.equal(await Booking.countDocuments({ roomType: c.standard._id }), 1);
        const loserIndex = results[0].status === 409 ? 0 : 1;
        const retry = await c.change(loserIndex === 0 ? a : b, c.suite, loserIndex === 0 ? c.ownerToken : c.otherToken);
        expectStatus(retry, 409);
        assert.equal(retry.body.code, 'CAPACITY_FULL');
    });

    await scenario('requirement 4: upgrade and new booking compete for the final room', async (c) => {
        await RoomType.updateOne({ _id: c.suite._id }, { totalCapacity: 1 });
        const booking = await c.book();
        const [change, create] = await Promise.all([
            c.change(booking, c.suite),
            request('POST', `/hotels/${c.h1.id}/bookings`, c.otherToken, { roomType: c.suite.id, checkIn: '2026-11-07', checkOut: '2026-11-08' })
        ]);
        assert.ok((change.status === 200 && create.status === 409) || (change.status === 409 && create.status === 201));
        assert.equal(await Booking.countDocuments({ roomType: c.suite._id }), 1);
    });

    await scenario('requirement 4: lost commit acknowledgement does not replay the room change', async (c, st) => {
        const booking = await c.book();
        const originalStart = mongoose.startSession;
        let lost = false;
        let commits = 0;
        st.mock.method(mongoose, 'startSession', async function (...args) {
            const session = await originalStart.apply(this, args);
            const commit = session.commitTransaction.bind(session);
            session.commitTransaction = async () => {
                commits++;
                await commit();
                if (!lost) {
                    lost = true;
                    const err = new Error('Lost acknowledgement');
                    err.errorLabels = ['UnknownTransactionCommitResult'];
                    throw err;
                }
            };
            return session;
        });
        const result = expectStatus(await c.change(booking, c.suite), 200);
        assert.equal(result.priceDifferenceSatang, 306000);
        assert.equal(commits, 2);
        assert.equal(await Booking.countDocuments({}), 1);
        assert.equal((await Booking.findById(booking._id)).totalPriceSatang, 612000);
    });

    await scenario('requirement 4: concurrent hotel move recomputes the actual locks before changing rooms', async (c, st) => {
        const booking = await c.book();
        const target = await RoomType.create({ hotel: c.h2._id, name: 'Other Suite', basePriceSatang: 200000, totalCapacity: 2 });
        const originalFind = Booking.findOne;
        let intercept = true;
        let versionAfterMove;
        st.mock.method(Booking, 'findOne', function (...args) {
            const query = originalFind.apply(this, args);
            if (intercept) {
                intercept = false;
                const then = query.then.bind(query);
                query.then = (resolve, reject) => then(async (initial) => {
                    expectStatus(await request('PUT', `/bookings/${booking._id}`, c.adminToken, { hotel: c.h2.id, roomType: c.foreign.id }), 200);
                    versionAfterMove = (await Hotel.findById(c.h2._id)).inventoryVersion;
                    return initial;
                }).then(resolve, reject);
            }
            return query;
        });
        const result = expectStatus(await c.change(booking, target), 200);
        assert.equal(result.booking.hotel, c.h2.id);
        assert.equal(result.booking.roomType, target.id);
        assert.equal((await Hotel.findById(c.h2._id)).inventoryVersion, versionAfterMove + 1);
    });

    await scenario('requirement 5: exact nightly totals, occupancy, zero rows, checkout exclusion and hotel isolation', async (c) => {
        await c.book();
        await c.book({ roomType: c.suite.id, checkIn: '2026-11-07', checkOut: '2026-11-08' }, c.otherToken);
        await c.book({ roomType: c.foreign.id }, c.otherToken, c.h2);
        const report = expectStatus(await c.report(), 200);
        assert.equal(report.capacityBasis, 'current');
        assert.equal(report.rows.length, 18);
        const row = (date, type) => report.rows.find((r) => r.date === date && r.roomType.id === type.id);
        assert.deepEqual(row('2026-11-06', c.standard), {
            date: '2026-11-06', roomType: { id: c.standard.id, name: 'Standard' }, capacity: 3,
            bookedRooms: 1, availableRooms: 2, occupancyRate: 33.33, revenueSatang: 90000
        });
        assert.equal(row('2026-11-07', c.standard).revenueSatang, 108000);
        assert.equal(row('2026-11-08', c.standard).revenueSatang, 108000);
        assert.equal(row('2026-11-07', c.suite).revenueSatang, 240000);
        assert.equal(row('2026-11-07', c.suite).occupancyRate, 50);
        assert.equal(row('2026-11-08', c.suite).bookedRooms, 0);
        assert.equal(row('2026-11-09', c.standard).bookedRooms, 0);
        assert.equal(row('2026-11-05', c.standard).revenueSatang, 0);
        assert.equal(row('2026-11-07', c.retired).bookedRooms, 0);
        assert.equal(report.rows.reduce((sum, r) => sum + r.revenueSatang, 0), 546000);
        const clipped = expectStatus(await c.report('from=2026-11-07&to=2026-11-07'), 200);
        assert.equal(clipped.rows.reduce((sum, r) => sum + r.revenueSatang, 0), 348000);
    });

    await scenario('requirement 5: admin only, optional type filter, date/ID validation and empty hotels', async (c) => {
        expectStatus(await c.report(undefined, c.ownerToken), 403);
        expectStatus(await request('GET', `/hotels/${c.h1.id}/analytics?from=2026-11-06&to=2026-11-06`), 401);
        const report = expectStatus(await c.report(`from=2026-11-01&to=2026-12-01&roomType=${c.standard.id}`), 200);
        assert.equal(report.rows.length, 31);
        assert.ok(report.rows.every((r) => r.roomType.id === c.standard.id));
        for (const query of [
            '', 'from=2026-11-06', 'from=2026-02-30&to=2026-03-01',
            'from=2026-11-07&to=2026-11-06', 'from=2026-11-01&to=2026-12-02',
            'from=2026-11-06&from=2026-11-07&to=2026-11-08',
            'from=2026-11-06&to=2026-11-07&roomType=bad', 'from=2026-11-06&to=2026-11-07&roomType='
        ]) expectStatus(await c.report(query), 400);
        expectStatus(await c.report(`from=2026-11-06&to=2026-11-07&roomType=${c.foreign.id}`), 404);
        expectStatus(await c.report(undefined, c.adminToken, { id: new mongoose.Types.ObjectId().toString() }), 404);
        expectStatus(await c.report(undefined, c.adminToken, { id: 'bad' }), 400);
        const empty = await Hotel.create(hotelData('Empty'));
        assert.deepEqual(expectStatus(await c.report(undefined, c.adminToken, empty), 200).rows, []);
    });

    await scenario('requirements 4-5: reports follow changed, inactive and deleted bookings', async (c) => {
        const booking = await c.book();
        expectStatus(await c.change(booking, c.suite), 200);
        expectStatus(await request('DELETE', `/hotels/${c.h1.id}/room-types/${c.suite.id}`, c.adminToken), 200);
        let rows = expectStatus(await c.report(), 200).rows;
        assert.equal(rows.filter((r) => r.roomType.id === c.standard.id).reduce((s, r) => s + r.revenueSatang, 0), 0);
        assert.equal(rows.filter((r) => r.roomType.id === c.suite.id).reduce((s, r) => s + r.revenueSatang, 0), 612000);
        assert.equal(expectStatus(await c.change(booking, c.suite), 200).priceDifferenceSatang, 0);
        expectStatus(await request('DELETE', `/bookings/${booking._id}`, c.ownerToken), 200);
        rows = expectStatus(await c.report(), 200).rows;
        assert.ok(rows.every((r) => r.revenueSatang === 0 && r.bookedRooms === 0));
    });

    await scenario('requirement 5: snapshot stays consistent while a room change commits between reads', async (c, st) => {
        const booking = await c.book();
        const originalFind = RoomType.find;
        let intercept = true;
        st.mock.method(RoomType, 'find', function (...args) {
            const query = originalFind.apply(this, args);
            if (intercept) {
                intercept = false;
                const then = query.then.bind(query);
                query.then = (resolve, reject) => then(async (types) => {
                    expectStatus(await c.change(booking, c.suite), 200);
                    return types;
                }).then(resolve, reject);
            }
            return query;
        });
        const snapshot = expectStatus(await c.report(), 200);
        assert.equal(snapshot.rows.filter((r) => r.roomType.id === c.standard.id).reduce((sum, r) => sum + r.revenueSatang, 0), 306000);
        assert.equal(snapshot.rows.filter((r) => r.roomType.id === c.suite.id).reduce((sum, r) => sum + r.revenueSatang, 0), 0);
        assert.equal((await Booking.findById(booking._id)).roomType.toString(), c.suite.id);
        const current = expectStatus(await c.report(), 200);
        assert.equal(current.rows.filter((r) => r.roomType.id === c.suite.id).reduce((sum, r) => sum + r.revenueSatang, 0), 612000);
    });

    await scenario('hotel deletion cascades bookings, types and inventory without touching other hotels', async (c) => {
        await c.book();
        await c.book({ roomType: c.foreign.id }, c.otherToken, c.h2);
        expectStatus(await request('DELETE', `/hotels/${c.h1.id}`, c.ownerToken), 403);
        expectStatus(await request('DELETE', `/hotels/${c.h1.id}`, c.adminToken), 200);
        assert.equal(await Booking.countDocuments({ hotel: c.h1._id }), 0);
        assert.equal(await RoomType.countDocuments({ hotel: c.h1._id }), 0);
        assert.equal(await RoomInventory.countDocuments({ hotel: c.h1._id }), 0);
        assert.equal(await Booking.countDocuments({ hotel: c.h2._id }), 1);
    });
});
