process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key';
process.env.JWT_EXPIRE = process.env.JWT_EXPIRE || '30d';
process.env.JWT_COOKIE_EXPIRE = process.env.JWT_COOKIE_EXPIRE || '30';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
    parseBookingDate,
    getBangkokTodayDate,
    enumerateStayDates,
    setClock,
    resetClock
} = require('../utils/date');
const {
    calculateNightAmountSatang,
    calculateStayQuote,
    quoteStay
} = require('../services/pricingService');
const {
    createAppError,
    withInventoryTransaction,
    reserveStay,
    releaseStay
} = require('../services/inventoryService');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const RoomInventory = require('../models/RoomInventory');
const Booking = require('../models/Booking');
const User = require('../models/User');
const bookingsController = require('../controllers/bookings');
const { migrateBookings } = require('../scripts/migrateBookings');
const app = require('../server');

const originalMethods = {
    startSession: mongoose.startSession,
    hotelFindByIdAndUpdate: Hotel.findByIdAndUpdate,
    hotelFind: Hotel.find,
    roomTypeFindById: RoomType.findById,
    roomTypeFind: RoomType.find,
    roomInventoryFind: RoomInventory.find,
    roomInventoryFindOne: RoomInventory.findOne,
    roomInventoryFindOneAndUpdate: RoomInventory.findOneAndUpdate,
    bookingFindOne: Booking.findOne,
    bookingCreate: Booking.create
};

const createMockQuery = (valueOrFactory) => {
    const resolveValue = async () =>
        typeof valueOrFactory === 'function'
            ? await valueOrFactory()
            : valueOrFactory;
    return {
        session() {
            return this;
        },
        then(onFulfilled, onRejected) {
            return resolveValue().then(onFulfilled, onRejected);
        },
        catch(onRejected) {
            return resolveValue().catch(onRejected);
        }
    };
};

const createMockRes = () => {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        set(key, val) {
            this.headers[key] = val;
            return this;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };
    return res;
};

test('Date Utils - Bangkok timezone boundary before and after midnight', (t) => {
    t.after(() => resetClock());

    // 2026-11-06 23:59:59 ICT (UTC+7) = 2026-11-06T16:59:59.000Z
    setClock(() => new Date('2026-11-06T16:59:59.000Z'));
    assert.equal(
        getBangkokTodayDate().toISOString(),
        '2026-11-06T00:00:00.000Z'
    );

    // 2026-11-07 00:00:00 ICT (UTC+7) = 2026-11-06T17:00:00.000Z
    setClock(() => new Date('2026-11-06T17:00:00.000Z'));
    assert.equal(
        getBangkokTodayDate().toISOString(),
        '2026-11-07T00:00:00.000Z'
    );
});

test('Date Utils - enumerateStayDates excludes checkOut night', () => {
    const dates = enumerateStayDates('2026-11-06', '2026-11-09');
    assert.equal(dates.length, 3);
    assert.deepEqual(
        dates.map((d) => d.toISOString().slice(0, 10)),
        ['2026-11-06', '2026-11-07', '2026-11-08']
    );
});

test('Dynamic Pricing v1 - weekday, weekend surcharge (+20%), 3-night discount (-10%), and half-up rounding', () => {
    // 1. Single weekday night (2026-11-05 is Thursday)
    const weekdayQuote = calculateStayQuote({
        basePriceSatang: 100000,
        checkIn: '2026-11-05',
        checkOut: '2026-11-06'
    });
    assert.equal(weekdayQuote.totalPriceSatang, 100000);
    assert.equal(weekdayQuote.pricingRuleVersion, 'v1');
    assert.equal(weekdayQuote.nightlyPrices.length, 1);
    assert.equal(weekdayQuote.nightlyPrices[0].amountSatang, 100000);

    // 2. Two weekend nights (2026-11-07 Sat, 2026-11-08 Sun) -> +20% each, no 3-night discount
    const weekendQuote = calculateStayQuote({
        basePriceSatang: 100000,
        checkIn: '2026-11-07',
        checkOut: '2026-11-09'
    });
    assert.equal(weekendQuote.totalPriceSatang, 240000);
    assert.deepEqual(
        weekendQuote.nightlyPrices.map((n) => n.amountSatang),
        [120000, 120000]
    );

    // 3. Mixed 3 nights (2026-11-06 Fri, 2026-11-07 Sat, 2026-11-08 Sun)
    // Fri: 100000 * 1.0 * 0.9 = 90000
    // Sat: 100000 * 1.2 * 0.9 = 108000
    // Sun: 100000 * 1.2 * 0.9 = 108000
    // Total: 306000
    const mixedThreeNightQuote = calculateStayQuote({
        basePriceSatang: 100000,
        checkIn: '2026-11-06',
        checkOut: '2026-11-09'
    });
    assert.equal(mixedThreeNightQuote.totalPriceSatang, 306000);
    assert.deepEqual(
        mixedThreeNightQuote.nightlyPrices.map((n) => n.amountSatang),
        [90000, 108000, 108000]
    );

    // 4. Half-up rounding check:
    // Weekday 3-night discount (90%): base = 105 -> 105 * 0.9 = 94.5 -> rounds half-up to 95
    assert.equal(
        calculateNightAmountSatang({
            basePriceSatang: 105,
            isWeekend: false,
            totalNights: 3
        }),
        95
    );
    // Weekend 3-night (1.2 * 0.9 = 1.08): base = 106 -> 106 * 1.08 = 114.48 -> rounds to 114
    assert.equal(
        calculateNightAmountSatang({
            basePriceSatang: 106,
            isWeekend: true,
            totalNights: 3
        }),
        114
    );
    // Weekend 3-night (1.08): base = 119 -> 119 * 1.08 = 128.52 -> rounds to 129
    assert.equal(
        calculateNightAmountSatang({
            basePriceSatang: 119,
            isWeekend: true,
            totalNights: 3
        }),
        129
    );
});

test('Dynamic Pricing v1 - rejects stays outside 1-3 nights or invalid dates', () => {
    assert.throws(
        () =>
            calculateStayQuote({
                basePriceSatang: 100000,
                checkIn: '2026-11-06',
                checkOut: '2026-11-06'
            }),
        /between 1 and 3 nights/
    );

    assert.throws(
        () =>
            calculateStayQuote({
                basePriceSatang: 100000,
                checkIn: '2026-11-06',
                checkOut: '2026-11-10'
            }),
        /between 1 and 3 nights/
    );
});

test('Models validation - RoomType and Booking schema rules', async () => {
    const invalidRoomType = new RoomType({
        hotel: new mongoose.Types.ObjectId(),
        name: 'Deluxe',
        basePriceSatang: -100,
        totalCapacity: 0
    });

    await assert.rejects(() => invalidRoomType.validate());

    const validBooking = new Booking({
        user: new mongoose.Types.ObjectId(),
        hotel: new mongoose.Types.ObjectId(),
        roomType: new mongoose.Types.ObjectId(),
        checkIn: '2026-11-06',
        checkOut: '2026-11-08',
        nightlyPrices: [
            { date: '2026-11-06', amountSatang: 100000 },
            { date: '2026-11-07', amountSatang: 120000 }
        ],
        totalPriceSatang: 220000
    });

    await validBooking.validate();
    assert.equal(validBooking.schemaVersion, 2);
    assert.equal(validBooking.pricingRuleVersion, 'v1');

    // Mismatched totalPriceSatang must fail validation
    const mismatchedBooking = new Booking({
        user: new mongoose.Types.ObjectId(),
        hotel: new mongoose.Types.ObjectId(),
        roomType: new mongoose.Types.ObjectId(),
        checkIn: '2026-11-06',
        checkOut: '2026-11-08',
        nightlyPrices: [
            { date: '2026-11-06', amountSatang: 100000 },
            { date: '2026-11-07', amountSatang: 120000 }
        ],
        totalPriceSatang: 999999
    });

    await assert.rejects(
        () => mismatchedBooking.validate(),
        /totalPriceSatang must equal the sum of nightlyPrices/
    );
});

test('Transaction Retry & Deterministic Hotel Lock Ordering (including dynamic hotelIds changes across retries)', async (t) => {
    const lockedOrder = [];
    const seenLockedSets = [];
    let attempts = 0;

    const fakeSession = {
        startTransaction: () => {},
        inTransaction: () => true,
        abortTransaction: async () => {},
        commitTransaction: async () => {},
        endSession: async () => {}
    };

    t.mock.method(mongoose, 'startSession', async () => fakeSession);
    t.mock.method(Hotel, 'findByIdAndUpdate', async (id) => {
        lockedOrder.push(id.toString());
        return { _id: id, inventoryVersion: 1 };
    });

    const hotelA = '670000000000000000000001';
    const hotelB = '670000000000000000000002';
    const hotelC = '670000000000000000000003';

    const dynamicHotelIds = [hotelC, hotelB, hotelC];

    const res = await withInventoryTransaction(
        { hotelIds: dynamicHotelIds },
        async (_session, lockedHotelIds) => {
            attempts += 1;
            seenLockedSets.push([...lockedHotelIds]);
            if (attempts === 1) {
                // Dynamically add hotelA (which sorts before hotelB and hotelC) for the retry
                dynamicHotelIds.push(hotelA);
                const transientErr = new Error('WriteConflict');
                transientErr.code = 112;
                throw transientErr;
            }
            return 'ok';
        }
    );

    assert.equal(res, 'ok');
    assert.equal(attempts, 2);
    // Attempt 1 locked [hotelB, hotelC]; Attempt 2 recomputed and locked [hotelA, hotelB, hotelC]
    assert.deepEqual(seenLockedSets, [
        [hotelB, hotelC],
        [hotelA, hotelB, hotelC]
    ]);
    assert.deepEqual(lockedOrder, [
        hotelB,
        hotelC,
        hotelA,
        hotelB,
        hotelC
    ]);
});

test('Regression (P1): UnknownTransactionCommitResult retries only commitTransaction without replaying booking callback', async (t) => {
    const hotelId = '670000000000000000000010';
    const roomTypeId = '670000000000000000000011';
    const userId = '670000000000000000000099';

    let commitCalls = 0;
    let abortCalls = 0;
    let reserveCalls = 0;
    let createBookingCalls = 0;

    const fakeSession = {
        startTransaction: () => {},
        inTransaction: () => true,
        abortTransaction: async () => {
            abortCalls += 1;
        },
        commitTransaction: async () => {
            commitCalls += 1;
            if (commitCalls === 1) {
                const unknownCommitErr = new Error(
                    'Network interrupted after commit sent'
                );
                unknownCommitErr.errorLabels = ['UnknownTransactionCommitResult'];
                unknownCommitErr.hasErrorLabel = (label) =>
                    label === 'UnknownTransactionCommitResult';
                throw unknownCommitErr;
            }
        },
        endSession: async () => {}
    };

    t.mock.method(mongoose, 'startSession', async () => fakeSession);
    t.mock.method(Hotel, 'findByIdAndUpdate', async (id) => ({
        _id: id,
        inventoryVersion: 1
    }));
    t.mock.method(RoomType, 'findById', () =>
        createMockQuery({
            _id: new mongoose.Types.ObjectId(roomTypeId),
            hotel: new mongoose.Types.ObjectId(hotelId),
            basePriceSatang: 100000,
            totalCapacity: 1,
            active: true
        })
    );
    t.mock.method(RoomInventory, 'find', () => createMockQuery([]));
    t.mock.method(RoomInventory, 'findOneAndUpdate', async () => {
        reserveCalls += 1;
        return {
            hotel: hotelId,
            roomType: roomTypeId,
            date: parseBookingDate('2026-11-06'),
            bookedRooms: reserveCalls
        };
    });
    t.mock.method(Booking, 'create', async (docs) => {
        createBookingCalls += 1;
        return [
            {
                _id: new mongoose.Types.ObjectId('670000000000000000000501'),
                ...docs[0]
            }
        ];
    });

    const req = {
        params: { hotelId },
        user: { id: userId, role: 'user' },
        body: {
            roomType: roomTypeId,
            checkIn: '2026-11-06',
            checkOut: '2026-11-07'
        }
    };
    const res = createMockRes();

    await bookingsController.addBooking(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(createBookingCalls, 1, 'Booking.create must run exactly once');
    assert.equal(reserveCalls, 1, 'Room inventory must be incremented only once');
    assert.equal(commitCalls, 2, 'commitTransaction must be retried on the same session');
    assert.equal(abortCalls, 0, 'abortTransaction must not be called on unknown commit result');
});

test('Regression (P1): updateBooking and deleteBooking recompute and lock moved hotel on retry', async (t) => {
    const hotelA = '670000000000000000000002'; // intentionally higher hex than hotelB to verify sort order
    const hotelB = '670000000000000000000001';
    const roomTypeB = '670000000000000000000022';
    const bookingId = '670000000000000000000301';
    const userId = '670000000000000000000099';

    let currentLockedHotels = [];
    const lockHistoryByAttempt = [];
    let currentAttemptLocks = [];

    const fakeSession = {
        startTransaction: () => {
            currentAttemptLocks = [];
        },
        inTransaction: () => true,
        abortTransaction: async () => {},
        commitTransaction: async () => {
            lockHistoryByAttempt.push([...currentAttemptLocks]);
        },
        endSession: async () => {}
    };

    t.mock.method(mongoose, 'startSession', async () => fakeSession);
    t.mock.method(Hotel, 'findByIdAndUpdate', async (id) => {
        const idStr = id.toString();
        currentAttemptLocks.push(idStr);
        currentLockedHotels = [...currentAttemptLocks];
        return { _id: id, inventoryVersion: 1 };
    });

    // --- Part 1: updateBooking race where booking moves from hotelA -> hotelB before attempt 1 lock ---
    let updateFindOneCalls = 0;
    let releaseHotelBWithoutLock = false;
    let savedBooking = false;

    const bookingFindOneMock = t.mock.method(Booking, 'findOne', () => {
        updateFindOneCalls += 1;
        // Call 1 is initialBooking outside transaction (sees hotelA)
        if (updateFindOneCalls === 1) {
            return createMockQuery({
                _id: new mongoose.Types.ObjectId(bookingId),
                user: new mongoose.Types.ObjectId(userId),
                hotel: new mongoose.Types.ObjectId(hotelA),
                roomType: new mongoose.Types.ObjectId(roomTypeB),
                checkIn: parseBookingDate('2026-11-06'),
                checkOut: parseBookingDate('2026-11-07')
            });
        }
        // Inside transaction (Attempt 1 & Attempt 2): booking was concurrently moved to hotelB
        return createMockQuery({
            _id: new mongoose.Types.ObjectId(bookingId),
            user: new mongoose.Types.ObjectId(userId),
            hotel: new mongoose.Types.ObjectId(hotelB),
            roomType: new mongoose.Types.ObjectId(roomTypeB),
            checkIn: parseBookingDate('2026-11-06'),
            checkOut: parseBookingDate('2026-11-07'),
            set(updates) {
                Object.assign(this, updates);
            },
            async save() {
                savedBooking = true;
                return this;
            }
        });
    });

    t.mock.method(RoomType, 'findById', () =>
        createMockQuery({
            _id: new mongoose.Types.ObjectId(roomTypeB),
            hotel: new mongoose.Types.ObjectId(hotelB),
            basePriceSatang: 100000,
            totalCapacity: 1,
            active: true
        })
    );

    t.mock.method(RoomInventory, 'findOne', ({ hotel }) =>
        createMockQuery(() => {
            if (!currentLockedHotels.includes(hotel.toString())) {
                releaseHotelBWithoutLock = true;
            }
            return {
                hotel,
                roomType: roomTypeB,
                date: parseBookingDate('2026-11-06'),
                bookedRooms: 1,
                async save() {}
            };
        })
    );

    t.mock.method(RoomInventory, 'find', () => createMockQuery([]));

    t.mock.method(RoomInventory, 'findOneAndUpdate', async ({ hotel }) => {
        if (!currentLockedHotels.includes(hotel.toString())) {
            releaseHotelBWithoutLock = true;
        }
        return {
            hotel,
            roomType: roomTypeB,
            date: parseBookingDate('2026-11-08'),
            bookedRooms: 1
        };
    });

    const updateReq = {
        params: { id: bookingId },
        user: { id: userId, role: 'user' },
        body: {
            checkIn: '2026-11-08',
            checkOut: '2026-11-09'
        }
    };
    const updateRes = createMockRes();

    await bookingsController.updateBooking(updateReq, updateRes);

    assert.equal(updateRes.statusCode, 200);
    assert.equal(savedBooking, true);
    assert.equal(
        releaseHotelBWithoutLock,
        false,
        'Must never mutate hotelB inventory without locking hotelB first'
    );
    // Committed attempt must have locked both hotelB and hotelA in sorted order
    assert.deepEqual(lockHistoryByAttempt, [[hotelB, hotelA]]);

    // --- Part 2: deleteBooking race where booking moves from hotelA -> hotelB before attempt 1 lock ---
    lockHistoryByAttempt.length = 0;
    let deleteFindOneCalls = 0;
    let deletedBooking = false;

    bookingFindOneMock.mock.mockImplementation(() => {
        deleteFindOneCalls += 1;
        if (deleteFindOneCalls === 1) {
            return createMockQuery({
                _id: new mongoose.Types.ObjectId(bookingId),
                user: new mongoose.Types.ObjectId(userId),
                hotel: new mongoose.Types.ObjectId(hotelA),
                roomType: new mongoose.Types.ObjectId(roomTypeB),
                checkIn: parseBookingDate('2026-11-08'),
                checkOut: parseBookingDate('2026-11-09')
            });
        }
        return createMockQuery({
            _id: new mongoose.Types.ObjectId(bookingId),
            user: new mongoose.Types.ObjectId(userId),
            hotel: new mongoose.Types.ObjectId(hotelB),
            roomType: new mongoose.Types.ObjectId(roomTypeB),
            checkIn: parseBookingDate('2026-11-08'),
            checkOut: parseBookingDate('2026-11-09'),
            async deleteOne() {
                if (!currentLockedHotels.includes(hotelB)) {
                    releaseHotelBWithoutLock = true;
                }
                deletedBooking = true;
            }
        });
    });

    const deleteReq = {
        params: { id: bookingId },
        user: { id: userId, role: 'user' }
    };
    const deleteRes = createMockRes();

    await bookingsController.deleteBooking(deleteReq, deleteRes);

    assert.equal(deleteRes.statusCode, 200);
    assert.equal(deletedBooking, true);
    assert.equal(
        releaseHotelBWithoutLock,
        false,
        'deleteBooking must lock hotelB on retry before releasing inventory or deleting'
    );
    assert.deepEqual(lockHistoryByAttempt, [[hotelB, hotelA]]);
});

test('Inventory Service - reserveStay rejects full capacity, inactive roomType, and hotel mismatch; releaseStay prevents underflow', async (t) => {
    const hotelId = new mongoose.Types.ObjectId('670000000000000000000010');
    const otherHotelId = new mongoose.Types.ObjectId('670000000000000000000099');
    const roomTypeId = new mongoose.Types.ObjectId('670000000000000000000011');
    const fakeSession = {};

    let currentMockRoomType = {
        _id: roomTypeId,
        hotel: hotelId,
        totalCapacity: 2,
        active: false
    };

    // Mock RoomType.findById only ONCE so teardown restores the real Mongoose method cleanly
    t.mock.method(RoomType, 'findById', () =>
        createMockQuery(() => currentMockRoomType)
    );

    // 1. Inactive roomType rejected with 400 ROOM_TYPE_INACTIVE
    await assert.rejects(
        () =>
            reserveStay({
                hotelId,
                roomTypeId,
                checkIn: '2026-11-06',
                checkOut: '2026-11-08',
                session: fakeSession
            }),
        (err) => err.statusCode === 400 && err.code === 'ROOM_TYPE_INACTIVE'
    );

    // 2. Hotel mismatch rejected with 400 ROOM_TYPE_HOTEL_MISMATCH
    currentMockRoomType = {
        _id: roomTypeId,
        hotel: otherHotelId,
        totalCapacity: 2,
        active: true
    };

    await assert.rejects(
        () =>
            reserveStay({
                hotelId,
                roomTypeId,
                checkIn: '2026-11-06',
                checkOut: '2026-11-08',
                session: fakeSession
            }),
        (err) => err.statusCode === 400 && err.code === 'ROOM_TYPE_HOTEL_MISMATCH'
    );

    // 3. Full capacity on one night rejected with 409 CAPACITY_FULL
    currentMockRoomType = {
        _id: roomTypeId,
        hotel: hotelId,
        totalCapacity: 2,
        active: true
    };

    t.mock.method(RoomInventory, 'find', () =>
        createMockQuery([
            {
                date: parseBookingDate('2026-11-07'),
                bookedRooms: 2
            }
        ])
    );

    await assert.rejects(
        () =>
            reserveStay({
                hotelId,
                roomTypeId,
                checkIn: '2026-11-06',
                checkOut: '2026-11-08',
                session: fakeSession
            }),
        (err) => err.statusCode === 409 && err.code === 'CAPACITY_FULL'
    );

    // 4. releaseStay prevents negative bookedRooms (INVENTORY_UNDERFLOW)
    t.mock.method(RoomInventory, 'findOne', () =>
        createMockQuery({
            date: parseBookingDate('2026-11-06'),
            bookedRooms: 0
        })
    );

    await assert.rejects(
        () =>
            releaseStay({
                hotelId,
                roomTypeId,
                checkIn: '2026-11-06',
                checkOut: '2026-11-07',
                session: fakeSession
            }),
        (err) => err.statusCode === 409 && err.code === 'INVENTORY_UNDERFLOW'
    );
});

test('Migration Dry-Run - detects missing manifest entries, hotel mismatch, negative prices, and over-capacity', async (t) => {
    const hotelId = new mongoose.Types.ObjectId('670000000000000000000010');
    const otherHotelId = new mongoose.Types.ObjectId('670000000000000000000020');
    const roomTypeId = new mongoose.Types.ObjectId('670000000000000000000011');
    const otherRoomTypeId = new mongoose.Types.ObjectId('670000000000000000000021');
    const booking1Id = new mongoose.Types.ObjectId('670000000000000000000101');
    const booking2Id = new mongoose.Types.ObjectId('670000000000000000000102');

    t.mock.method(Booking.collection, 'find', () => ({
        toArray: async () => [
            {
                _id: booking1Id,
                hotel: hotelId,
                checkIn: parseBookingDate('2026-11-06'),
                checkOut: parseBookingDate('2026-11-08')
            },
            {
                _id: booking2Id,
                hotel: hotelId,
                checkIn: parseBookingDate('2026-11-06'),
                checkOut: parseBookingDate('2026-11-08')
            }
        ]
    }));

    t.mock.method(Hotel, 'find', () => ({
        lean: async () => [
            { _id: hotelId, name: 'H1' },
            { _id: otherHotelId, name: 'H2' }
        ]
    }));

    t.mock.method(RoomType, 'find', () => ({
        lean: async () => [
            { _id: roomTypeId, hotel: hotelId, totalCapacity: 1 },
            { _id: otherRoomTypeId, hotel: otherHotelId, totalCapacity: 5 }
        ]
    }));

    // 1. Capacity exceeded (2 bookings on capacity=1 roomType on same dates)
    const overCapResult = await migrateBookings({
        mode: 'dry-run',
        manifest: [
            {
                bookingId: booking1Id.toString(),
                roomTypeId: roomTypeId.toString(),
                nightlyPrices: [
                    { date: '2026-11-06', amountSatang: 100000 },
                    { date: '2026-11-07', amountSatang: 120000 }
                ]
            },
            {
                bookingId: booking2Id.toString(),
                roomTypeId: roomTypeId.toString(),
                nightlyPrices: [
                    { date: '2026-11-06', amountSatang: 100000 },
                    { date: '2026-11-07', amountSatang: 120000 }
                ]
            }
        ]
    });

    assert.equal(overCapResult.success, false);
    assert.equal(
        overCapResult.errors.some((e) => e.code === 'CAPACITY_EXCEEDED'),
        true
    );

    // 2. Wrong hotel roomType & missing booking2
    const mismatchResult = await migrateBookings({
        mode: 'dry-run',
        manifest: [
            {
                bookingId: booking1Id.toString(),
                roomTypeId: otherRoomTypeId.toString(),
                nightlyPrices: [
                    { date: '2026-11-06', amountSatang: 100000 },
                    { date: '2026-11-07', amountSatang: 120000 }
                ]
            }
        ]
    });

    assert.equal(mismatchResult.success, false);
    assert.equal(
        mismatchResult.errors.some((e) => e.code === 'ROOM_TYPE_HOTEL_MISMATCH'),
        true
    );
    assert.equal(
        mismatchResult.errors.some((e) => e.code === 'MISSING_MANIFEST_ENTRY'),
        true
    );
});

test('Unit test teardown verification - all Mongoose model methods are restored to originals', () => {
    assert.equal(mongoose.startSession, originalMethods.startSession);
    assert.equal(Hotel.findByIdAndUpdate, originalMethods.hotelFindByIdAndUpdate);
    assert.equal(Hotel.find, originalMethods.hotelFind);
    assert.equal(RoomType.findById, originalMethods.roomTypeFindById);
    assert.equal(RoomType.find, originalMethods.roomTypeFind);
    assert.equal(RoomInventory.find, originalMethods.roomInventoryFind);
    assert.equal(RoomInventory.findOne, originalMethods.roomInventoryFindOne);
    assert.equal(
        RoomInventory.findOneAndUpdate,
        originalMethods.roomInventoryFindOneAndUpdate
    );
    assert.equal(Booking.findOne, originalMethods.bookingFindOne);
    assert.equal(Booking.create, originalMethods.bookingCreate);
});

const TEST_MONGO_URI = process.env.TEST_MONGO_URI;
const { assertTestDatabase } = require('../utils/testDatabase');

test(
    'Integration & Concurrency (MongoDB Replica Set) - Requirements 1 to 3 and Migration',
    { skip: !TEST_MONGO_URI ? 'Set TEST_MONGO_URI to run MongoDB transaction integration tests' : false },
    async (t) => {
        // Ensure no unit test stubs leaked into integration
        assert.equal(RoomType.findById, originalMethods.roomTypeFindById);
        assert.equal(Booking.findOne, originalMethods.bookingFindOne);

        assertTestDatabase(TEST_MONGO_URI);
        await mongoose.connect(TEST_MONGO_URI);
        let server;
        let baseUrl;

        await new Promise((resolve) => {
            server = app.listen(0, () => {
                const { port } = server.address();
                baseUrl = `http://127.0.0.1:${port}/api/v1`;
                resolve();
            });
        });

        t.after(async () => {
            resetClock();
            if (server) {
                await new Promise((resolve) => server.close(resolve));
            }
            if (mongoose.connection.readyState !== 0) {
                await mongoose.connection.dropDatabase();
                await mongoose.disconnect();
            }
        });

        await User.deleteMany({});
        await Hotel.deleteMany({});
        await RoomType.deleteMany({});
        await RoomInventory.deleteMany({});
        await Booking.deleteMany({});

        const adminUser = await User.create({
            name: 'Admin Hill',
            phone: '0811111111',
            email: 'admin@hotel.test',
            password: 'password123',
            role: 'admin'
        });
        const normalUser = await User.create({
            name: 'Guest User',
            phone: '0822222222',
            email: 'guest@hotel.test',
            password: 'password123',
            role: 'user'
        });

        const adminToken = adminUser.getSignedJwtToken();
        const userToken = normalUser.getSignedJwtToken();

        const requestJson = async (method, path, { token, body } = {}) => {
            const headers = { 'Content-Type': 'application/json' };
            if (token) {
                headers.Authorization = `Bearer ${token}`;
            }
            const res = await fetch(`${baseUrl}${path}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined
            });
            const data = await res.json();
            return { status: res.status, body: data };
        };

        // Create two hotels
        const hotel1Res = await requestJson('POST', '/hotels', {
            token: adminToken,
            body: {
                name: 'Grand Bangkok Hotel',
                address: '123 Sukhumvit',
                district: 'Watthana',
                province: 'Bangkok',
                postalcode: '10110',
                tel: '021111111'
            }
        });
        assert.equal(hotel1Res.status, 201);
        const hotel1Id = hotel1Res.body.data._id;

        const hotel2Res = await requestJson('POST', '/hotels', {
            token: adminToken,
            body: {
                name: 'Riverside Hotel',
                address: '456 Charoenkrung',
                district: 'Bang Rak',
                province: 'Bangkok',
                postalcode: '10500',
                tel: '022222222'
            }
        });
        assert.equal(hotel2Res.status, 201);
        const hotel2Id = hotel2Res.body.data._id;

        // Requirement 1: Create RoomTypes
        const rtDeluxeRes = await requestJson(
            'POST',
            `/hotels/${hotel1Id}/room-types`,
            {
                token: adminToken,
                body: {
                    name: 'Deluxe',
                    basePriceSatang: 100000,
                    amenities: ['WiFi', 'Breakfast'],
                    totalCapacity: 1
                }
            }
        );
        assert.equal(rtDeluxeRes.status, 201);
        const deluxeId = rtDeluxeRes.body.data._id;

        const rtSuiteRes = await requestJson(
            'POST',
            `/hotels/${hotel1Id}/room-types`,
            {
                token: adminToken,
                body: {
                    name: 'Suite',
                    basePriceSatang: 200000,
                    amenities: ['WiFi', 'Jacuzzi'],
                    totalCapacity: 2
                }
            }
        );
        assert.equal(rtSuiteRes.status, 201);
        const suiteId = rtSuiteRes.body.data._id;

        const rtHotel2Res = await requestJson(
            'POST',
            `/hotels/${hotel2Id}/room-types`,
            {
                token: adminToken,
                body: {
                    name: 'Standard',
                    basePriceSatang: 80000,
                    amenities: ['WiFi'],
                    totalCapacity: 2
                }
            }
        );
        assert.equal(rtHotel2Res.status, 201);
        const hotel2RoomTypeId = rtHotel2Res.body.data._id;

        // Requirement 3: Concurrent last-room booking (totalCapacity = 1 on Deluxe)
        const [conc1, conc2] = await Promise.all([
            requestJson('POST', `/hotels/${hotel1Id}/bookings`, {
                token: userToken,
                body: {
                    roomType: deluxeId,
                    checkIn: '2026-11-06',
                    checkOut: '2026-11-09'
                }
            }),
            requestJson('POST', `/hotels/${hotel1Id}/bookings`, {
                token: adminToken,
                body: {
                    roomType: deluxeId,
                    checkIn: '2026-11-07',
                    checkOut: '2026-11-09'
                }
            })
        ]);

        const statuses = [conc1.status, conc2.status].sort();
        assert.deepEqual(statuses, [201, 409]);

        const winner = conc1.status === 201 ? conc1 : conc2;
        const loser = conc1.status === 409 ? conc1 : conc2;
        assert.ok(['CAPACITY_FULL', 'TRANSACTION_CONFLICT'].includes(loser.body.code));
        assert.equal(
            await Booking.countDocuments({ hotel: hotel1Id, roomType: deluxeId }),
            1
        );
        const concurrentInventory = await RoomInventory.find({
            hotel: hotel1Id,
            roomType: deluxeId
        });
        assert.ok(concurrentInventory.length > 0);
        assert.ok(concurrentInventory.every((inv) => inv.bookedRooms === 1));

        // Once the winning transaction has committed, a fresh request must see full capacity.
        const fullAfterCommit = await requestJson('POST', `/hotels/${hotel1Id}/bookings`, {
            token: userToken,
            body: {
                roomType: deluxeId,
                checkIn: '2026-11-07',
                checkOut: '2026-11-09'
            }
        });
        assert.equal(fullAfterCommit.status, 409);
        assert.equal(fullAfterCommit.body.code, 'CAPACITY_FULL');

        // Back-to-back booking on checkOut date (2026-11-09 to 2026-11-10) must succeed
        const backToBackRes = await requestJson(
            'POST',
            `/hotels/${hotel1Id}/bookings`,
            {
                token: userToken,
                body: {
                    roomType: deluxeId,
                    checkIn: '2026-11-09',
                    checkOut: '2026-11-10'
                }
            }
        );
        assert.equal(backToBackRes.status, 201);

        // Integration Regression (P1): UnknownTransactionCommitResult after real commit
        // must retry commit only and never create duplicate booking or double-book inventory
        const realStartSession = mongoose.startSession.bind(mongoose);
        let injectedUnknownCommit = false;
        mongoose.startSession = async (...args) => {
            const session = await realStartSession(...args);
            const origCommit = session.commitTransaction.bind(session);
            session.commitTransaction = async (...cArgs) => {
                await origCommit(...cArgs);
                if (!injectedUnknownCommit) {
                    injectedUnknownCommit = true;
                    const err = new Error('Simulated lost commit acknowledgement');
                    err.errorLabels = ['UnknownTransactionCommitResult'];
                    err.hasErrorLabel = (label) =>
                        label === 'UnknownTransactionCommitResult';
                    throw err;
                }
            };
            return session;
        };

        try {
            const unknownCommitBookingRes = await requestJson(
                'POST',
                `/hotels/${hotel1Id}/bookings`,
                {
                    token: userToken,
                    body: {
                        roomType: suiteId,
                        checkIn: '2026-11-15',
                        checkOut: '2026-11-16'
                    }
                }
            );
            assert.equal(unknownCommitBookingRes.status, 201);

            const suiteBookingsOnNov15 = await Booking.countDocuments({
                hotel: hotel1Id,
                roomType: suiteId,
                checkIn: parseBookingDate('2026-11-15')
            });
            assert.equal(suiteBookingsOnNov15, 1);

            const suiteInvOnNov15 = await RoomInventory.findOne({
                hotel: hotel1Id,
                roomType: suiteId,
                date: parseBookingDate('2026-11-15')
            });
            assert.equal(suiteInvOnNov15.bookedRooms, 1);

            await Booking.deleteOne({ _id: unknownCommitBookingRes.body.data._id });
            await RoomInventory.deleteOne({ _id: suiteInvOnNov15._id });
        } finally {
            mongoose.startSession = realStartSession;
        }

        // Update booking: reject same-hotel roomType change via PUT
        const rejectSameHotelRoomChange = await requestJson(
            'PUT',
            `/bookings/${winner.body.data._id}`,
            {
                token: adminToken,
                body: {
                    roomType: suiteId
                }
            }
        );
        assert.equal(rejectSameHotelRoomChange.status, 400);
        assert.equal(rejectSameHotelRoomChange.body.code, 'USE_ROOM_TYPE_ENDPOINT');

        // Update booking: move hotel via PUT with new hotel's roomType
        const moveHotelRes = await requestJson(
            'PUT',
            `/bookings/${backToBackRes.body.data._id}`,
            {
                token: userToken,
                body: {
                    hotel: hotel2Id,
                    roomType: hotel2RoomTypeId,
                    checkIn: '2026-11-09',
                    checkOut: '2026-11-11'
                }
            }
        );
        assert.equal(moveHotelRes.status, 200);
        assert.equal(moveHotelRes.body.data.hotel, hotel2Id);
        assert.equal(moveHotelRes.body.data.totalPriceSatang, 160000);

        // Integration Regression (P1): Concurrent hotel move between initial read and transaction lock
        // on PUT and DELETE must recompute and lock the moved hotel on retry
        const raceBookingRes = await requestJson(
            'POST',
            `/hotels/${hotel1Id}/bookings`,
            {
                token: userToken,
                body: {
                    roomType: suiteId,
                    checkIn: '2026-11-18',
                    checkOut: '2026-11-19'
                }
            }
        );
        assert.equal(raceBookingRes.status, 201);
        const raceBookingId = raceBookingRes.body.data._id;

        const realBookingFindOne = Booking.findOne.bind(Booking);
        let interceptInitialPutRead = true;
        Booking.findOne = function (...args) {
            const query = realBookingFindOne(...args);
            if (interceptInitialPutRead) {
                interceptInitialPutRead = false;
                const origThen = query.then.bind(query);
                query.then = function (onFulfilled, onRejected) {
                    return origThen(async (initialDoc) => {
                        // Concurrently move the booking to hotel2 before PUT enters its transaction
                        const movedRes = await requestJson(
                            'PUT',
                            `/bookings/${raceBookingId}`,
                            {
                                token: adminToken,
                                body: {
                                    hotel: hotel2Id,
                                    roomType: hotel2RoomTypeId,
                                    checkIn: '2026-11-18',
                                    checkOut: '2026-11-19'
                                }
                            }
                        );
                        assert.equal(movedRes.status, 200);
                        return initialDoc;
                    }).then(onFulfilled, onRejected);
                };
            }
            return query;
        };

        try {
            const hotel2BeforePutRace = await Hotel.findById(hotel2Id);
            const putAfterConcurrentMoveRes = await requestJson(
                'PUT',
                `/bookings/${raceBookingId}`,
                {
                    token: userToken,
                    body: {
                        checkIn: '2026-11-19',
                        checkOut: '2026-11-20'
                    }
                }
            );
            assert.equal(putAfterConcurrentMoveRes.status, 200);
            assert.equal(putAfterConcurrentMoveRes.body.data.hotel, hotel2Id);

            const hotel2AfterPutRace = await Hotel.findById(hotel2Id);
            assert.equal(
                hotel2AfterPutRace.inventoryVersion >
                    hotel2BeforePutRace.inventoryVersion,
                true,
                'hotel2 must be locked via inventoryVersion bump during retry'
            );
        } finally {
            Booking.findOne = realBookingFindOne;
        }

        // Same race on DELETE: booking moves from hotel1 to hotel2 right after initial read
        const raceDeleteBookingRes = await requestJson(
            'POST',
            `/hotels/${hotel1Id}/bookings`,
            {
                token: userToken,
                body: {
                    roomType: suiteId,
                    checkIn: '2026-11-20',
                    checkOut: '2026-11-21'
                }
            }
        );
        assert.equal(raceDeleteBookingRes.status, 201);
        const raceDeleteBookingId = raceDeleteBookingRes.body.data._id;

        let interceptInitialDeleteRead = true;
        Booking.findOne = function (...args) {
            const query = realBookingFindOne(...args);
            if (interceptInitialDeleteRead) {
                interceptInitialDeleteRead = false;
                const origThen = query.then.bind(query);
                query.then = function (onFulfilled, onRejected) {
                    return origThen(async (initialDoc) => {
                        const movedRes = await requestJson(
                            'PUT',
                            `/bookings/${raceDeleteBookingId}`,
                            {
                                token: adminToken,
                                body: {
                                    hotel: hotel2Id,
                                    roomType: hotel2RoomTypeId,
                                    checkIn: '2026-11-20',
                                    checkOut: '2026-11-21'
                                }
                            }
                        );
                        assert.equal(movedRes.status, 200);
                        return initialDoc;
                    }).then(onFulfilled, onRejected);
                };
            }
            return query;
        };

        try {
            const deleteAfterConcurrentMoveRes = await requestJson(
                'DELETE',
                `/bookings/${raceDeleteBookingId}`,
                {
                    token: userToken
                }
            );
            assert.equal(deleteAfterConcurrentMoveRes.status, 200);

            const h2Nov20Inv = await RoomInventory.findOne({
                hotel: hotel2Id,
                roomType: hotel2RoomTypeId,
                date: parseBookingDate('2026-11-20')
            });
            assert.equal(h2Nov20Inv.bookedRooms, 0);
        } finally {
            Booking.findOne = realBookingFindOne;
        }

        // Clean up raceBookingId so migration test below only sees expected bookings
        const cleanupRaceBookingRes = await requestJson(
            'DELETE',
            `/bookings/${raceBookingId}`,
            {
                token: userToken
            }
        );
        assert.equal(cleanupRaceBookingRes.status, 200);

        // Delete booking releases inventory
        const delRes = await requestJson(
            'DELETE',
            `/bookings/${winner.body.data._id}`,
            {
                token: adminToken
            }
        );
        assert.equal(delRes.status, 200);

        const invAfterDelete = await RoomInventory.find({
            hotel: hotel1Id,
            roomType: deluxeId
        });
        assert.equal(
            invAfterDelete.every((i) => i.bookedRooms === 0),
            true
        );

        // Migration test: insert a legacy v1 booking directly into collection
        const legacyBookingId = new mongoose.Types.ObjectId();
        await Booking.collection.insertOne({
            _id: legacyBookingId,
            user: normalUser._id,
            hotel: new mongoose.Types.ObjectId(hotel1Id),
            checkIn: parseBookingDate('2026-12-01'),
            checkOut: parseBookingDate('2026-12-03'),
            createdAt: new Date()
        });

        const manifest = [
            {
                bookingId: legacyBookingId.toString(),
                roomTypeId: suiteId,
                nightlyPrices: [
                    { date: '2026-12-01', amountSatang: 200000 },
                    { date: '2026-12-02', amountSatang: 200000 }
                ]
            }
        ];

        const dryRunRes = await migrateBookings({
            manifest,
            mode: 'dry-run'
        });
        assert.equal(dryRunRes.success, true);

        const applyRes1 = await migrateBookings({
            manifest,
            mode: 'apply'
        });
        assert.equal(applyRes1.success, true);

        // Re-running apply must be idempotent and not duplicate bookedRooms
        const applyRes2 = await migrateBookings({
            manifest,
            mode: 'apply'
        });
        assert.equal(applyRes2.success, true);

        const dec1Inv = await RoomInventory.findOne({
            hotel: hotel1Id,
            roomType: suiteId,
            date: parseBookingDate('2026-12-01')
        });
        assert.equal(dec1Inv.bookedRooms, 1);
    }
);
