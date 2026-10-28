const mongoose = require('mongoose');

const DAY_IN_MS = 24 * 60 * 60 * 1000;

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
    return value instanceof Date &&
        Number.isFinite(value.getTime()) &&
        value.getTime() % DAY_IN_MS === 0;
};

const BookingSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true,
        index: true
    },
    hotel: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hotel',
        required: true,
        index: true
    },
    checkIn: {
        type: Date,
        required: [true, 'Please add a check-in date'],
        set: parseBookingDate,
        validate: {
            validator: isCalendarDate,
            message: 'Check-in must be a calendar date at midnight UTC'
        }
    },
    checkOut: {
        type: Date,
        required: [true, 'Please add a check-out date'],
        set: parseBookingDate,
        validate: {
            validator: isCalendarDate,
            message: 'Check-out must be a calendar date at midnight UTC'
        }
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});


BookingSchema.pre('validate', function () {
    if (!isCalendarDate(this.checkIn) || !isCalendarDate(this.checkOut)) {
        return;
    }

    const nights = (this.checkOut - this.checkIn) / DAY_IN_MS;

    if (!Number.isInteger(nights) || nights < 1 || nights > 3) {
        this.invalidate(
            'checkOut',
            'A booking must be between 1 and 3 nights'
        );
    }
});

module.exports = mongoose.model('Booking', BookingSchema);