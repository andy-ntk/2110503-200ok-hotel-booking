const mongoose = require('mongoose');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const Booking = require('../models/Booking');
const { createAppError } = require('./inventoryService');
const { DAY_IN_MS, parseBookingDate, isCalendarDate, enumerateStayDates, formatDateYMD } = require('../utils/date');

const parseAnalyticsRange = (from, to) => {
    let start;
    let end;
    try {
        start = parseBookingDate(from);
        end = parseBookingDate(to);
    } catch (err) {
        throw createAppError(err.message, 400, 'INVALID_DATE_RANGE');
    }
    if (!isCalendarDate(start) || !isCalendarDate(end)) {
        throw createAppError('from and to must be calendar dates in YYYY-MM-DD format', 400, 'INVALID_DATE_RANGE');
    }
    const days = (end - start) / DAY_IN_MS + 1;
    if (days < 1 || days > 31) {
        throw createAppError('Date range must contain 1 to 31 days, inclusive', 400, 'INVALID_DATE_RANGE');
    }
    return { start, end, endExclusive: new Date(end.getTime() + DAY_IN_MS) };
};

const buildDailyRows = (dates, roomTypes, totals) => {
    const byTypeAndDate = new Map(totals.map((total) => [
        `${total._id.roomType}:${formatDateYMD(total._id.date)}`, total
    ]));
    return dates.flatMap((date) => roomTypes.map((roomType) => {
        const day = formatDateYMD(date);
        const total = byTypeAndDate.get(`${roomType._id}:${day}`);
        const bookedRooms = total?.bookedRooms ?? 0;
        return {
            date: day,
            roomType: { id: roomType._id.toString(), name: roomType.name },
            capacity: roomType.totalCapacity,
            bookedRooms,
            availableRooms: roomType.totalCapacity - bookedRooms,
            occupancyRate: Math.round(bookedRooms / roomType.totalCapacity * 10000) / 100,
            revenueSatang: total?.revenueSatang ?? 0
        };
    }));
};

const getHotelAnalytics = async ({ hotelId, from, to, roomType }) => {
    if (!mongoose.isObjectIdOrHexString(hotelId)) {
        throw createAppError('Hotel must be a valid ObjectId', 400, 'INVALID_HOTEL_ID');
    }
    if (roomType !== undefined && !mongoose.isObjectIdOrHexString(roomType)) {
        throw createAppError('Room type must be a valid ObjectId', 400, 'INVALID_ROOM_TYPE_ID');
    }
    const { start, end, endExclusive } = parseAnalyticsRange(from, to);
    const hotel = new mongoose.Types.ObjectId(hotelId);
    const typeFilter = { hotel };
    if (roomType !== undefined) typeFilter._id = new mongoose.Types.ObjectId(roomType);

    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            if (!await Hotel.findById(hotel).session(session).lean()) {
                throw createAppError('Hotel not found', 404, 'HOTEL_NOT_FOUND');
            }
            // Include inactive types: existing bookings still contribute to reporting.
            const roomTypes = await RoomType.find(typeFilter).sort({ _id: 1 }).session(session).lean();
            if (roomType !== undefined && roomTypes.length === 0) {
                throw createAppError('Room type not found in this hotel', 404, 'ROOM_TYPE_NOT_FOUND');
            }
            const filter = {
                hotel,
                schemaVersion: 2,
                checkIn: { $lt: endExclusive },
                checkOut: { $gt: start }
            };
            if (typeFilter._id) filter.roomType = typeFilter._id;
            const totals = await Booking.aggregate([
                { $match: filter },
                { $unwind: '$nightlyPrices' },
                { $match: { 'nightlyPrices.date': { $gte: start, $lte: end } } },
                { $group: {
                    _id: { roomType: '$roomType', date: '$nightlyPrices.date' },
                    bookedRooms: { $sum: 1 },
                    revenueSatang: { $sum: '$nightlyPrices.amountSatang' }
                } }
            ]).session(session);
            return {
                hotelId: hotel.toString(),
                from: formatDateYMD(start),
                to: formatDateYMD(end),
                capacityBasis: 'current',
                rows: buildDailyRows(enumerateStayDates(start, endExclusive), roomTypes, totals)
            };
        }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' });
    } finally {
        await session.endSession();
    }
};

module.exports = { getHotelAnalytics, parseAnalyticsRange, buildDailyRows };
