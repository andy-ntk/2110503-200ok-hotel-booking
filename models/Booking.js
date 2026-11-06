const mongoose = require('mongoose');
const {
    DAY_IN_MS,
    parseBookingDate,
    isCalendarDate,
    enumerateStayDates
} = require('../utils/date');

const isNonNegativeInteger = (value) => {
    return Number.isInteger(value) && value >= 0;
};

const NightlyPriceSchema = new mongoose.Schema(
    {
        date: {
            type: Date,
            required: true,
            set: parseBookingDate,
            validate: {
                validator: isCalendarDate,
                message: 'Nightly price date must be a calendar date at midnight UTC'
            }
        },
        amountSatang: {
            type: Number,
            required: true,
            validate: {
                validator: isNonNegativeInteger,
                message: 'amountSatang must be an integer greater than or equal to 0'
            }
        }
    },
    { _id: false }
);

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
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: [true, 'Please add a room type'],
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
    nightlyPrices: {
        type: [NightlyPriceSchema],
        required: [true, 'Please add nightly prices']
    },
    totalPriceSatang: {
        type: Number,
        required: [true, 'Please add total price in satang'],
        validate: {
            validator: isNonNegativeInteger,
            message: 'totalPriceSatang must be an integer greater than or equal to 0'
        }
    },
    pricingRuleVersion: {
        type: String,
        required: true,
        default: 'v1'
    },
    schemaVersion: {
        type: Number,
        required: true,
        default: 2
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

BookingSchema.index({ hotel: 1, roomType: 1, checkIn: 1, checkOut: 1 });

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
        return;
    }

    const expectedDates = enumerateStayDates(this.checkIn, this.checkOut);

    if (
        !Array.isArray(this.nightlyPrices) ||
        this.nightlyPrices.length !== expectedDates.length
    ) {
        this.invalidate(
            'nightlyPrices',
            'nightlyPrices must contain one entry for each stay night'
        );
        return;
    }

    let computedTotal = 0;
    for (let i = 0; i < expectedDates.length; i++) {
        const entry = this.nightlyPrices[i];
        if (
            !entry ||
            !isCalendarDate(entry.date) ||
            entry.date.getTime() !== expectedDates[i].getTime() ||
            !isNonNegativeInteger(entry.amountSatang)
        ) {
            this.invalidate(
                'nightlyPrices',
                'nightlyPrices dates must match each stay night in order with valid satang amounts'
            );
            return;
        }
        computedTotal += entry.amountSatang;
    }

    if (this.totalPriceSatang !== computedTotal) {
        this.invalidate(
            'totalPriceSatang',
            'totalPriceSatang must equal the sum of nightlyPrices'
        );
    }
});

module.exports = mongoose.model('Booking', BookingSchema);
