const Booking = require('../models/Booking');
const Hotel = require('../models/Hotel');
const mongoose = require('mongoose');
const {
    createAppError,
    withInventoryTransaction,
    reserveStay,
    releaseStay
} = require('../services/inventoryService');
const { quoteStay } = require('../services/pricingService');

const sendBookingError = (res, err, fallbackMessage) => {
    const isValidationError =
        err.name === 'ValidationError' || err.name === 'CastError';
    const statusCode = err.statusCode || (isValidationError ? 400 : 500);
    const body = {
        success: false,
        message:
            err.statusCode || isValidationError
                ? err.message
                : fallbackMessage
    };

    if (err.code) {
        body.code = err.code;
    }

    return res.status(statusCode).json(body);
};

// @desc    Get all bookings
// @route   GET /api/v1/bookings
// @route   GET /api/v1/hotels/:hotelId/bookings
// @access  Private
exports.getBookings = async (req, res, next) => {
    try {
        let query;
        const filter = {};
        // General users can see only their bookings
        if (req.user.role !== 'admin') {
            filter.user = req.user.id;
        }

        // Filter by hotel when called through the hotel route.
        if (req.params.hotelId) {
            const hotel = await Hotel.findById(req.params.hotelId);

            if (!hotel) {
                return res.status(404).json({
                    success: false,
                    message: `No hotel with the id of ${req.params.hotelId}`
                });
            }

            filter.hotel = req.params.hotelId;
        }

        query = Booking.find(filter).populate({
            path: 'hotel',
            select: 'name address tel'
        });

        const bookings = await query;

        res.status(200).json({
            success: true,
            count: bookings.length,
            data: bookings
        });
    } catch (err) {
        console.log(err.stack);

        const status = err.name === 'CastError' ? 400 : 500;

        return res.status(status).json({
            success: false,
            message: 'Cannot find bookings'
        });
    }
};

// @desc    Get a single booking
// @route   GET /api/v1/bookings/:id
// @access  Private
exports.getBooking = async (req, res, next) => {
    try {
        const filter = { _id: req.params.id };

        if (req.params.hotelId) {
            filter.hotel = req.params.hotelId;
        }

        const booking = await Booking.findOne(filter).populate({
            path: 'hotel',
            select: 'name address tel'
        });

        if (!booking) {
            return res.status(404).json({
                success: false,
                message: `No booking with the id of ${req.params.id}`
            });
        }

        // Make sure user owns the booking or is an admin
        if (
            booking.user.toString() !== req.user.id &&
            req.user.role !== 'admin'
        ) {
            return res.status(403).json({
                success: false,
                message: `User ${req.user.id} is not authorized to view this booking`
            });
        }

        res.status(200).json({
            success: true,
            data: booking
        });
    } catch (err) {
        console.log(err.stack);

        const status = err.name === 'CastError' ? 400 : 500;

        return res.status(status).json({
            success: false,
            message: 'Cannot find booking'
        });
    }
};

// @desc    Add booking
// @route   POST /api/v1/hotels/:hotelId/bookings
// @access  Private
exports.addBooking = async (req, res, next) => {
    try {
        // Creation must specify a hotel through the URL.
        if (!req.params.hotelId) {
            res.set('Allow', 'GET');

            return res.status(405).json({
                success: false,
                message: 'Create bookings through /api/v1/hotels/:hotelId/bookings'
            });
        }

        // Only accept booking dates and roomType from the client.
        const allowedFields = ['checkIn', 'checkOut', 'roomType'];

        if (
            !req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).some(
                (field) => !allowedFields.includes(field)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: 'Provide only checkIn, checkOut, and roomType'
            });
        }

        if (!req.body.roomType) {
            return res.status(400).json({
                success: false,
                message: 'Please add a room type'
            });
        }

        const booking = await withInventoryTransaction(
            { hotelIds: [req.params.hotelId] },
            async (session) => {
                await reserveStay({
                    hotelId: req.params.hotelId,
                    roomTypeId: req.body.roomType,
                    checkIn: req.body.checkIn,
                    checkOut: req.body.checkOut,
                    session
                });

                const quote = await quoteStay({
                    roomTypeId: req.body.roomType,
                    checkIn: req.body.checkIn,
                    checkOut: req.body.checkOut,
                    session
                });

                const [createdBooking] = await Booking.create(
                    [
                        {
                            user: req.user.id,
                            hotel: req.params.hotelId,
                            roomType: req.body.roomType,
                            checkIn: req.body.checkIn,
                            checkOut: req.body.checkOut,
                            nightlyPrices: quote.nightlyPrices,
                            totalPriceSatang: quote.totalPriceSatang,
                            pricingRuleVersion: quote.pricingRuleVersion,
                            schemaVersion: 2
                        }
                    ],
                    { session }
                );

                return createdBooking;
            }
        );

        res.status(201).json({
            success: true,
            data: booking
        });
    } catch (err) {
        console.log(err.stack);
        return sendBookingError(res, err, 'Cannot create booking');
    }
};

// @desc    Update booking
// @route   PUT /api/v1/bookings/:id
// @route   PUT /api/v1/hotels/:hotelId/bookings/:id
// @access  Private
exports.updateBooking = async (req, res, next) => {
    try {
        const allowedFields = ['checkIn', 'checkOut', 'hotel', 'roomType'];

        if (
            !req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length === 0 ||
            Object.keys(req.body).some(
                (field) => !allowedFields.includes(field)
            )
        ) {
            return res.status(400).json({
                success: false,
                message: 'Provide at least one of: checkIn, checkOut, hotel, roomType'
            });
        }

        if (
            Object.hasOwn(req.body, 'hotel') &&
            !mongoose.isObjectIdOrHexString(req.body.hotel)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Hotel must be a valid ObjectId'
            });
        }

        if (
            Object.hasOwn(req.body, 'roomType') &&
            !mongoose.isObjectIdOrHexString(req.body.roomType)
        ) {
            return res.status(400).json({
                success: false,
                message: 'Room type must be a valid ObjectId'
            });
        }

        const filter = { _id: req.params.id };
        if (req.params.hotelId) {
            filter.hotel = req.params.hotelId;
        }

        const initialBooking = await Booking.findOne(filter);
        if (!initialBooking) {
            return res.status(404).json({
                success: false,
                message: `No booking with the id of ${req.params.id}`
            });
        }

        const hotelIdsToLock = [initialBooking.hotel.toString()];
        if (Object.hasOwn(req.body, 'hotel')) {
            hotelIdsToLock.push(req.body.hotel.toString());
        }

        const updatedBooking = await withInventoryTransaction(
            { hotelIds: hotelIdsToLock },
            async (session, lockedHotelIds = []) => {
                const booking = await Booking.findOne(filter).session(session);
                if (!booking) {
                    throw createAppError(
                        `No booking with the id of ${req.params.id}`,
                        404,
                        'BOOKING_NOT_FOUND'
                    );
                }

                const currentHotelId = booking.hotel.toString();
                const targetHotelId = Object.hasOwn(req.body, 'hotel')
                    ? req.body.hotel.toString()
                    : currentHotelId;

                const lockedSet = new Set(
                    lockedHotelIds.map((id) => id.toString())
                );

                // Verify that the actual locked hotel set for this attempt covers both
                // the booking's current hotel and target hotel; otherwise add and retry
                if (
                    !lockedSet.has(currentHotelId) ||
                    !lockedSet.has(targetHotelId)
                ) {
                    if (!hotelIdsToLock.includes(currentHotelId)) {
                        hotelIdsToLock.push(currentHotelId);
                    }
                    if (!hotelIdsToLock.includes(targetHotelId)) {
                        hotelIdsToLock.push(targetHotelId);
                    }
                    const retryErr = new Error('Booking hotel changed concurrently');
                    retryErr.isTransientRetry = true;
                    throw retryErr;
                }

                // Make sure user is the booking owner or an admin
                if (
                    booking.user.toString() !== req.user.id &&
                    req.user.role !== 'admin'
                ) {
                    throw createAppError(
                        `User ${req.user.id} is not authorized to update this booking`,
                        403,
                        'FORBIDDEN'
                    );
                }

                const isChangingHotel = targetHotelId !== currentHotelId;

                if (isChangingHotel && !Object.hasOwn(req.body, 'roomType')) {
                    throw createAppError(
                        'Please provide roomType when moving booking to another hotel',
                        400,
                        'ROOM_TYPE_REQUIRED_FOR_HOTEL_CHANGE'
                    );
                }

                if (!isChangingHotel && Object.hasOwn(req.body, 'roomType')) {
                    throw createAppError(
                        'Use PATCH /api/v1/bookings/:id/room-type to change room type within the same hotel',
                        400,
                        'USE_ROOM_TYPE_ENDPOINT'
                    );
                }

                const targetRoomTypeId = isChangingHotel
                    ? req.body.roomType
                    : booking.roomType;
                const targetCheckIn = Object.hasOwn(req.body, 'checkIn')
                    ? req.body.checkIn
                    : booking.checkIn;
                const targetCheckOut = Object.hasOwn(req.body, 'checkOut')
                    ? req.body.checkOut
                    : booking.checkOut;

                await releaseStay({
                    hotelId: booking.hotel,
                    roomTypeId: booking.roomType,
                    checkIn: booking.checkIn,
                    checkOut: booking.checkOut,
                    session
                });

                await reserveStay({
                    hotelId: targetHotelId,
                    roomTypeId: targetRoomTypeId,
                    checkIn: targetCheckIn,
                    checkOut: targetCheckOut,
                    session
                });

                const quote = await quoteStay({
                    roomTypeId: targetRoomTypeId,
                    checkIn: targetCheckIn,
                    checkOut: targetCheckOut,
                    session
                });

                booking.set({
                    hotel: targetHotelId,
                    roomType: targetRoomTypeId,
                    checkIn: targetCheckIn,
                    checkOut: targetCheckOut,
                    nightlyPrices: quote.nightlyPrices,
                    totalPriceSatang: quote.totalPriceSatang,
                    pricingRuleVersion: quote.pricingRuleVersion,
                    schemaVersion: 2
                });

                await booking.save({ session });
                return booking;
            }
        );

        res.status(200).json({
            success: true,
            data: updatedBooking
        });
    } catch (err) {
        console.log(err.stack);
        return sendBookingError(res, err, 'Cannot update booking');
    }
};

// @desc    Delete booking
// @route   DELETE /api/v1/bookings/:id
// @route   DELETE /api/v1/hotels/:hotelId/bookings/:id
// @access  Private
exports.deleteBooking = async (req, res, next) => {
    try {
        const filter = { _id: req.params.id };

        if (req.params.hotelId) {
            filter.hotel = req.params.hotelId;
        }

        const initialBooking = await Booking.findOne(filter);

        if (!initialBooking) {
            return res.status(404).json({
                success: false,
                message: `No booking with the id of ${req.params.id}`
            });
        }

        const hotelIdsToLock = [initialBooking.hotel.toString()];

        await withInventoryTransaction(
            { hotelIds: hotelIdsToLock },
            async (session, lockedHotelIds = []) => {
                const booking = await Booking.findOne(filter).session(session);
                if (!booking) {
                    throw createAppError(
                        `No booking with the id of ${req.params.id}`,
                        404,
                        'BOOKING_NOT_FOUND'
                    );
                }

                const currentHotelId = booking.hotel.toString();
                const lockedSet = new Set(
                    lockedHotelIds.map((id) => id.toString())
                );

                if (!lockedSet.has(currentHotelId)) {
                    if (!hotelIdsToLock.includes(currentHotelId)) {
                        hotelIdsToLock.push(currentHotelId);
                    }
                    const retryErr = new Error('Booking hotel changed concurrently');
                    retryErr.isTransientRetry = true;
                    throw retryErr;
                }

                // Make sure user is the booking owner or an admin.
                if (
                    booking.user.toString() !== req.user.id &&
                    req.user.role !== 'admin'
                ) {
                    throw createAppError(
                        `User ${req.user.id} is not authorized to delete this booking`,
                        403,
                        'FORBIDDEN'
                    );
                }

                await releaseStay({
                    hotelId: booking.hotel,
                    roomTypeId: booking.roomType,
                    checkIn: booking.checkIn,
                    checkOut: booking.checkOut,
                    session
                });

                await booking.deleteOne({ session });
            }
        );

        res.status(200).json({
            success: true,
            data: {}
        });
    } catch (err) {
        console.log(err.stack);
        return sendBookingError(res, err, 'Cannot delete booking');
    }
};
