const Booking = require('../models/Booking');
const Hotel = require('../models/Hotel');
const mongoose = require('mongoose');

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
        if(req.params.hotelId) {
            const hotel = await Hotel.findById(req.params.hotelId);

            if(!hotel) {
                return res.status(404).json({ success: false, message: `No hotel with the id of ${req.params.hotelId}` });
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
        const filter = {_id: req.params.id};
        
        if(req.params.hotelId){
            filter.hotel = req.params.hotelId;
        }

        const booking = await Booking.findOne(filter).populate({
            path: 'hotel',
            select: 'name address tel'
        });

        if(!booking) {
            return res.status(404).json({ success: false, message: `No booking with the id of ${req.params.id}` });
        }

        // Make sure user owns the booking or is an admin
        if(booking.user.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: `User ${req.user.id} is not authorized to view this booking` });
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

        // Only accept booking dates from the client.
        const allowedFields = ['checkIn', 'checkOut'];

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
                message: 'Provide only checkIn and checkOut'
            });
        }

        req.body.hotel = req.params.hotelId;

        const hotel = await Hotel.findById(req.params.hotelId);

        if (!hotel) {
            return res.status(404).json({
                success: false,
                message: `No hotel with the id of ${req.params.hotelId}`
            });
        }

        // Add the logged-in user's ID to req.body.
        req.body.user = req.user.id;

        const booking = await Booking.create(req.body);

        res.status(201).json({
            success: true,
            data: booking
        });
    } catch (err) {
        console.log(err.stack);

        const isValidationError =
            err.name === 'ValidationError' ||
            err.name === 'CastError';

        return res.status(isValidationError ? 400 : 500).json({
            success: false,
            message: isValidationError
                ? err.message
                : 'Cannot create booking'
        });
    }
};

// @desc    Update booking
// @route   PUT /api/v1/bookings/:id
// @access  Private
exports.updateBooking = async (req, res, next) => {
    try {
        const booking = await Booking.findById(req.params.id);

        if (!booking) {
            return res.status(404).json({
                success: false,
                message: `No booking with the id of ${req.params.id}`
            });
        }

        // Make sure user is the booking owner or an admin.
        if (
            booking.user.toString() !== req.user.id &&
            req.user.role !== 'admin'
        ) {
            return res.status(403).json({
                success: false,
                message: `User ${req.user.id} is not authorized to update this booking`
            });
        }

        const allowedFields = ['checkIn', 'checkOut', 'hotel'];

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
                message: 'Provide at least one of: checkIn, checkOut, hotel'
            });
        }

        // Validate the new hotel when changing hotels.
        if (Object.hasOwn(req.body, 'hotel')) {
            if (!mongoose.isObjectIdOrHexString(req.body.hotel)) {
                return res.status(400).json({
                    success: false,
                    message: 'Hotel must be a valid ObjectId'
                });
            }

            const hotel = await Hotel.findById(req.body.hotel);

            if (!hotel) {
                return res.status(404).json({
                    success: false,
                    message: `No hotel with the id of ${req.body.hotel}`
                });
            }
        }

        booking.set(req.body);
        await booking.save();

        res.status(200).json({
            success: true,
            data: booking
        });
    } catch (err) {
        console.log(err.stack);

        const isValidationError =
            err.name === 'ValidationError' ||
            err.name === 'CastError';

        return res.status(isValidationError ? 400 : 500).json({
            success: false,
            message: isValidationError
                ? err.message
                : 'Cannot update booking'
        });
    }
};

// @desc    Delete booking
// @route   DELETE /api/v1/bookings/:id
// @access  Private
exports.deleteBooking = async (req, res, next) => {
    try {
        const booking = await Booking.findById(req.params.id);

        if (!booking) {
            return res.status(404).json({
                success: false,
                message: `No booking with the id of ${req.params.id}`
            });
        }

        // Make sure user is the booking owner or an admin.
        if (
            booking.user.toString() !== req.user.id &&
            req.user.role !== 'admin'
        ) {
            return res.status(403).json({
                success: false,
                message: `User ${req.user.id} is not authorized to delete this booking`
            });
        }

        await booking.deleteOne();

        res.status(200).json({
            success: true,
            data: {}
        });
    } catch (err) {
        console.log(err.stack);

        const status = err.name === 'CastError' ? 400 : 500;

        return res.status(status).json({
            success: false,
            message: 'Cannot delete booking'
        });
    }
};