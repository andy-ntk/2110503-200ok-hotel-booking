const Hotel = require('../models/Hotel');
const Booking = require('../models/Booking');
const RoomType = require('../models/RoomType');
const RoomInventory = require('../models/RoomInventory');
const { withInventoryTransaction } = require('../services/inventoryService');

// @desc    Get all hotels
// @route   GET /api/v1/hotels
// @access  Public
exports.getHotels = async (req, res, next) => {
    try {
        const hotels = await Hotel.find();
        res.status(200).json({
            success: true,
            count: hotels.length,
            data: hotels
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Get single hotel
// @route   GET /api/v1/hotels/:id
// @access  Public
exports.getHotel = async (req, res, next) => {
    try {
        const hotel = await Hotel.findById(req.params.id);
        if (!hotel) {
            return res.status(404).json({
                success: false,
                message: `Hotel not found with id of ${req.params.id}`
            });
        }
        res.status(200).json({
            success: true,
            data: hotel
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Create new hotel
// @route   POST /api/v1/hotels
// @access  Private
exports.createHotel = async (req, res, next) => {
    try {
        const hotel = await Hotel.create(req.body);
        res.status(201).json({
            success: true,
            data: hotel
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Update hotel
// @route   PUT /api/v1/hotels/:id
// @access  Private
exports.updateHotel = async (req, res, next) => {
    try {
        const hotel = await Hotel.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true
        });
        if (!hotel) {
            return res.status(404).json({
                success: false,
                message: `Hotel not found with id of ${req.params.id}`
            });
        }
        res.status(200).json({
            success: true,
            data: hotel
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            message: err.message
        });
    }
};

// @desc    Delete hotel
// @route   DELETE /api/v1/hotels/:id
// @access  Private
exports.deleteHotel = async (req, res, next) => {
    try {
        await withInventoryTransaction(
            { hotelIds: [req.params.id] },
            async (session) => {
                await Booking.deleteMany({ hotel: req.params.id }).session(session);
                await RoomInventory.deleteMany({ hotel: req.params.id }).session(session);
                await RoomType.deleteMany({ hotel: req.params.id }).session(session);
                await Hotel.deleteOne({ _id: req.params.id }).session(session);
            }
        );

        res.status(200).json({
            success: true,
            data: {}
        });
    } catch (err) {
        console.log(err.stack);

        if (err.statusCode) {
            const body = {
                success: false,
                message: err.message
            };
            if (err.code) {
                body.code = err.code;
            }
            return res.status(err.statusCode).json(body);
        }

        const status = err.name === 'CastError' ? 400 : 500;

        return res.status(status).json({
            success: false,
            message: 'Cannot delete hotel'
        });
    }
};
