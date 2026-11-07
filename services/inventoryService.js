const mongoose = require('mongoose');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const RoomInventory = require('../models/RoomInventory');
const {
    DAY_IN_MS,
    parseBookingDate,
    isCalendarDate,
    enumerateStayDates
} = require('../utils/date');

const MAX_TRANSACTION_RETRIES = 3;

const createAppError = (message, statusCode, code) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    if (code) {
        err.code = code;
    }
    return err;
};

const hasErrorLabel = (err, label) => {
    if (!err) {
        return false;
    }

    if (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel(label)) {
        return true;
    }

    if (Array.isArray(err.errorLabels) && err.errorLabels.includes(label)) {
        return true;
    }

    return false;
};

const isUnknownCommitError = (err) => {
    if (!err) {
        return false;
    }

    if (err.code === 50 || err.codeName === 'MaxTimeMSExpired') {
        return false;
    }

    return (
        hasErrorLabel(err, 'UnknownTransactionCommitResult') &&
        !hasErrorLabel(err, 'TransientTransactionError')
    );
};

const isTransientTransactionError = (err) => {
    if (!err) {
        return false;
    }

    if (hasErrorLabel(err, 'TransientTransactionError')) {
        return true;
    }

    // WriteConflict (112) or duplicate key race during upsert (11000) inside transaction
    if (err.code === 112 || err.code === 11000 || err.isTransientRetry) {
        return true;
    }

    return false;
};

const normalizeSortedHotelIds = (hotelIds = []) => {
    const uniqueIds = Array.from(
        new Set(
            hotelIds
                .filter((id) => id !== undefined && id !== null)
                .map((id) => id.toString())
        )
    );
    uniqueIds.sort();
    return uniqueIds;
};

const resolveAndValidateHotelIds = (hotelIdsInput) => {
    const rawHotelIds =
        typeof hotelIdsInput === 'function' ? hotelIdsInput() : hotelIdsInput;
    const sortedHotelIds = normalizeSortedHotelIds(rawHotelIds || []);

    for (const id of sortedHotelIds) {
        if (!mongoose.isObjectIdOrHexString(id)) {
            throw createAppError(
                'Hotel must be a valid ObjectId',
                400,
                'INVALID_HOTEL_ID'
            );
        }
    }

    return sortedHotelIds;
};

const withInventoryTransaction = async ({ hotelIds = [] } = {}, callback) => {
    resolveAndValidateHotelIds(hotelIds);

    let lastError;

    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt++) {
        const sortedHotelIds = resolveAndValidateHotelIds(hotelIds);
        const session = await mongoose.startSession();
        let commitStarted = false;

        try {
            let result;
            session.startTransaction();

            const lockedHotelIds = [];
            // Lock each hotel in deterministic sorted order by bumping inventoryVersion
            for (const hotelId of sortedHotelIds) {
                const lockedHotel = await Hotel.findByIdAndUpdate(
                    hotelId,
                    { $inc: { inventoryVersion: 1 } },
                    { new: true, session }
                );

                if (!lockedHotel) {
                    throw createAppError(
                        `No hotel with the id of ${hotelId}`,
                        404,
                        'HOTEL_NOT_FOUND'
                    );
                }

                lockedHotelIds.push(hotelId);
            }

            result = await callback(session, lockedHotelIds);

            commitStarted = true;
            for (
                let commitAttempt = 1;
                commitAttempt <= MAX_TRANSACTION_RETRIES;
                commitAttempt++
            ) {
                try {
                    await session.commitTransaction();
                    break;
                } catch (commitErr) {
                    if (
                        isUnknownCommitError(commitErr) &&
                        commitAttempt < MAX_TRANSACTION_RETRIES
                    ) {
                        continue;
                    }
                    throw commitErr;
                }
            }

            return result;
        } catch (err) {
            if (!commitStarted && session.inTransaction()) {
                try {
                    await session.abortTransaction();
                } catch (_abortErr) {
                    // Ignore abort errors when transaction state already transitioned
                }
            }

            lastError = err;

            if (
                isTransientTransactionError(err) &&
                attempt < MAX_TRANSACTION_RETRIES
            ) {
                continue;
            }

            if (isTransientTransactionError(err) || isUnknownCommitError(err)) {
                throw createAppError(
                    'Transaction conflict after retries, please try again',
                    409,
                    'TRANSACTION_CONFLICT'
                );
            }

            throw err;
        } finally {
            await session.endSession();
        }
    }

    throw lastError;
};

const validateStayDates = (checkIn, checkOut) => {
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

    return enumerateStayDates(checkInDate, checkOutDate);
};

const reserveStay = async ({
    hotelId,
    roomTypeId,
    checkIn,
    checkOut,
    session
}) => {
    if (!session) {
        throw createAppError(
            'Database session is required for reserveStay',
            500,
            'SESSION_REQUIRED'
        );
    }

    if (!mongoose.isObjectIdOrHexString(hotelId)) {
        throw createAppError('Hotel must be a valid ObjectId', 400, 'INVALID_HOTEL_ID');
    }

    if (!mongoose.isObjectIdOrHexString(roomTypeId)) {
        throw createAppError(
            'Room type must be a valid ObjectId',
            400,
            'INVALID_ROOM_TYPE_ID'
        );
    }

    const stayDates = validateStayDates(checkIn, checkOut);

    const roomType = await RoomType.findById(roomTypeId).session(session);
    if (!roomType) {
        throw createAppError(
            `No room type with the id of ${roomTypeId}`,
            404,
            'ROOM_TYPE_NOT_FOUND'
        );
    }

    if (roomType.hotel.toString() !== hotelId.toString()) {
        throw createAppError(
            `Room type ${roomTypeId} does not belong to hotel ${hotelId}`,
            400,
            'ROOM_TYPE_HOTEL_MISMATCH'
        );
    }

    if (!roomType.active) {
        throw createAppError(
            `Room type ${roomTypeId} is inactive and cannot accept reservations`,
            400,
            'ROOM_TYPE_INACTIVE'
        );
    }

    const existingInventories = await RoomInventory.find({
        hotel: hotelId,
        roomType: roomTypeId,
        date: { $in: stayDates }
    }).session(session);

    const bookedByTime = new Map(
        existingInventories.map((inv) => [inv.date.getTime(), inv.bookedRooms])
    );

    for (const date of stayDates) {
        const currentBooked = bookedByTime.get(date.getTime()) || 0;
        if (currentBooked + 1 > roomType.totalCapacity) {
            throw createAppError(
                'Selected room type is at full capacity for one or more requested nights',
                409,
                'CAPACITY_FULL'
            );
        }
    }

    const updatedInventories = [];
    for (const date of stayDates) {
        const inv = await RoomInventory.findOneAndUpdate(
            {
                hotel: hotelId,
                roomType: roomTypeId,
                date
            },
            {
                $inc: { bookedRooms: 1 }
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
                runValidators: true,
                session
            }
        );

        if (inv.bookedRooms > roomType.totalCapacity) {
            throw createAppError(
                'Selected room type is at full capacity for one or more requested nights',
                409,
                'CAPACITY_FULL'
            );
        }

        updatedInventories.push(inv);
    }

    return updatedInventories;
};

const releaseStay = async ({
    hotelId,
    roomTypeId,
    checkIn,
    checkOut,
    session
}) => {
    if (!session) {
        throw createAppError(
            'Database session is required for releaseStay',
            500,
            'SESSION_REQUIRED'
        );
    }

    if (!mongoose.isObjectIdOrHexString(hotelId)) {
        throw createAppError('Hotel must be a valid ObjectId', 400, 'INVALID_HOTEL_ID');
    }

    if (!mongoose.isObjectIdOrHexString(roomTypeId)) {
        throw createAppError(
            'Room type must be a valid ObjectId',
            400,
            'INVALID_ROOM_TYPE_ID'
        );
    }

    const stayDates = validateStayDates(checkIn, checkOut);

    const updatedInventories = [];
    for (const date of stayDates) {
        const inv = await RoomInventory.findOne({
            hotel: hotelId,
            roomType: roomTypeId,
            date
        }).session(session);

        if (!inv || inv.bookedRooms < 1) {
            throw createAppError(
                'Cannot release room inventory below 0',
                409,
                'INVENTORY_UNDERFLOW'
            );
        }

        inv.bookedRooms -= 1;
        await inv.save({ session });
        updatedInventories.push(inv);
    }

    return updatedInventories;
};

module.exports = {
    createAppError,
    withInventoryTransaction,
    reserveStay,
    releaseStay
};
