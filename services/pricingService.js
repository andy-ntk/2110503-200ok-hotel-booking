const mongoose = require('mongoose');
const RoomType = require('../models/RoomType');
const {
    DAY_IN_MS,
    parseBookingDate,
    isCalendarDate,
    enumerateStayDates
} = require('../utils/date');
const { createAppError } = require('./inventoryService');

const PRICING_RULE_VERSION = 'v1';

const isWeekendNight = (date) => {
    const dayOfWeek = date.getUTCDay();
    return dayOfWeek === 0 || dayOfWeek === 6;
};

const calculateNightAmountSatang = ({
    basePriceSatang,
    isWeekend,
    totalNights
}) => {
    const surchargePercent = isWeekend ? 120 : 100;
    const discountPercent = totalNights === 3 ? 90 : 100;

    // Exact half-up rounding in satang: (base * surcharge% * discount%) / 10000
    const numerator = basePriceSatang * surchargePercent * discountPercent;
    return Math.floor((numerator + 5000) / 10000);
};

const calculateStayQuote = ({ basePriceSatang, checkIn, checkOut }) => {
    if (!Number.isInteger(basePriceSatang) || basePriceSatang < 0) {
        throw createAppError(
            'basePriceSatang must be a non-negative integer',
            400,
            'INVALID_BASE_PRICE'
        );
    }

    let checkInDate;
    let checkOutDate;
    try {
        checkInDate = parseBookingDate(checkIn);
        checkOutDate = parseBookingDate(checkOut);
    } catch (err) {
        throw createAppError(err.message, 400, 'INVALID_DATE');
    }

    if (!isCalendarDate(checkInDate) || !isCalendarDate(checkOutDate)) {
        throw createAppError(
            'Check-in and check-out must be calendar dates at midnight UTC',
            400,
            'INVALID_DATE'
        );
    }

    const nights = (checkOutDate - checkInDate) / DAY_IN_MS;
    if (!Number.isInteger(nights) || nights < 1 || nights > 3) {
        throw createAppError(
            'A booking must be between 1 and 3 nights',
            400,
            'INVALID_STAY_LENGTH'
        );
    }

    const stayDates = enumerateStayDates(checkInDate, checkOutDate);

    const nightlyPrices = stayDates.map((date) => {
        const amountSatang = calculateNightAmountSatang({
            basePriceSatang,
            isWeekend: isWeekendNight(date),
            totalNights: nights
        });

        return {
            date,
            amountSatang
        };
    });

    const totalPriceSatang = nightlyPrices.reduce(
        (sum, night) => sum + night.amountSatang,
        0
    );

    return {
        nightlyPrices,
        totalPriceSatang,
        pricingRuleVersion: PRICING_RULE_VERSION
    };
};

const quoteStay = async ({ roomTypeId, checkIn, checkOut, session = null }) => {
    if (!mongoose.isObjectIdOrHexString(roomTypeId)) {
        throw createAppError(
            'Room type must be a valid ObjectId',
            400,
            'INVALID_ROOM_TYPE_ID'
        );
    }

    const query = RoomType.findById(roomTypeId);
    if (session) {
        query.session(session);
    }

    const roomType = await query;
    if (!roomType) {
        throw createAppError(
            `Room type not found with id of ${roomTypeId}`,
            404,
            'ROOM_TYPE_NOT_FOUND'
        );
    }

    return calculateStayQuote({
        basePriceSatang: roomType.basePriceSatang,
        checkIn,
        checkOut
    });
};

module.exports = {
    PRICING_RULE_VERSION,
    isWeekendNight,
    calculateNightAmountSatang,
    calculateStayQuote,
    quoteStay
};
