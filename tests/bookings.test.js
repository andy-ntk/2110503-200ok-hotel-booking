const assert = require('node:assert/strict');
const { test } = require('node:test');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const { updateBooking, deleteBooking } = require('../controllers/bookings');

// Exercise controller behavior with real Mongoose documents and mocked persistence.
// No database connection or application credentials are needed.
const fixture = (t) => {
    const booking = new Booking({
        user: new mongoose.Types.ObjectId(),
        hotel: new mongoose.Types.ObjectId(),
        checkIn: '2026-11-01',
        checkOut: '2026-11-02'
    });
    const original = booking.toObject();
    const state = { stored: booking.toObject() };

    t.mock.method(Booking, 'findOne', async (filter) => {
        const matches = Object.entries(filter).every(([key, value]) =>
            String(original[key]) === String(value));
        return matches ? booking : null;
    });
    t.mock.method(booking, 'save', async () => {
        await booking.validate();
        state.stored = booking.toObject();
        return booking;
    });
    t.mock.method(booking, 'deleteOne', async () => {
        state.stored = null;
        return { deletedCount: 1 };
    });

    return {
        booking,
        original,
        state,
        owner: { id: booking.user.toString(), role: 'user' },
        admin: { id: new mongoose.Types.ObjectId().toString(), role: 'admin' },
        stranger: { id: new mongoose.Types.ObjectId().toString(), role: 'user' }
    };
};

const invoke = async (controller, context, user, params) => {
    const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
    await controller({
        params: { id: context.booking.id, ...params },
        user,
        body: { checkOut: '2026-11-03' }
    }, response);
    return response;
};

for (const [action, controller] of Object.entries({
    update: updateBooking,
    delete: deleteBooking
})) {
    for (const role of ['owner', 'admin']) {
        test(`${action}: ${role} cannot mutate a booking through another hotel`, async (t) => {
            const context = fixture(t);
            const response = await invoke(controller, context, context[role], {
                hotelId: new mongoose.Types.ObjectId().toString()
            });

            assert.equal(response.statusCode, 404);
            assert.equal(response.body.success, false);
            assert.deepEqual(context.state.stored, context.original);
        });

        for (const route of ['matching hotel', 'top-level']) {
            test(`${action}: ${role} succeeds through the ${route} route`, async (t) => {
                const context = fixture(t);
                const params = route === 'matching hotel'
                    ? { hotelId: context.booking.hotel.toString() } : {};
                const response = await invoke(controller, context, context[role], params);

                assert.equal(response.statusCode, 200);
                assert.equal(response.body.success, true);
                if (action === 'delete') {
                    assert.equal(context.state.stored, null);
                    assert.deepEqual(response.body.data, {});
                } else {
                    assert.deepEqual(context.state.stored, {
                        ...context.original,
                        checkOut: new Date('2026-11-03T00:00:00.000Z')
                    });
                }
            });
        }
    }

    for (const route of ['matching hotel', 'top-level', 'wrong hotel']) {
        test(`${action}: a non-owner is rejected through the ${route} route`, async (t) => {
            const context = fixture(t);
            const params = route === 'top-level' ? {} : {
                hotelId: route === 'matching hotel' ? context.booking.hotel.toString()
                    : new mongoose.Types.ObjectId().toString()
            };
            const response = await invoke(controller, context, context.stranger, params);

            assert.equal(response.statusCode, route === 'wrong hotel' ? 404 : 403);
            assert.equal(response.body.success, false);
            assert.deepEqual(context.state.stored, context.original);
        });
    }

    for (const route of ['matching hotel', 'top-level']) {
        test(`${action}: a missing booking returns 404 through the ${route} route`, async (t) => {
            const context = fixture(t);
            const params = { id: new mongoose.Types.ObjectId().toString() };
            if (route === 'matching hotel') params.hotelId = context.booking.hotel.toString();
            const response = await invoke(controller, context, context.owner, params);

            assert.equal(response.statusCode, 404);
            assert.equal(response.body.success, false);
            assert.deepEqual(context.state.stored, context.original);
        });
    }
}
