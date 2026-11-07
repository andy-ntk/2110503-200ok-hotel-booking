const mongoose = require('mongoose');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const RoomInventory = require('../models/RoomInventory');
const { getBangkokTodayDate } = require('../utils/date');
const { createAppError, withInventoryTransaction } = require('../services/inventoryService');

const sendErrorResponse = (res, err, fallbackMessage) => {
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

// @desc    Get all room types for a hotel
// @route   GET /api/v1/hotels/:hotelId/room-types
// @access  Public
exports.getRoomTypes = async (req, res, next) => {
    try {
        const hotel = await Hotel.findById(req.params.hotelId);
        if (!hotel) {
            return res.status(404).json({
                success: false,
                message: `Hotel not found with id of ${req.params.hotelId}`
            });
        }

        const roomTypes = await RoomType.find({ hotel: req.params.hotelId });

        res.status(200).json({
            success: true,
            count: roomTypes.length,
            data: roomTypes
        });
    } catch (err) {
        return sendErrorResponse(res, err, 'Cannot find room types');
    }
};

// @desc    Get single room type for a hotel
// @route   GET /api/v1/hotels/:hotelId/room-types/:roomTypeId
// @access  Public
exports.getRoomType = async (req, res, next) => {
    try {
        const hotel = await Hotel.findById(req.params.hotelId);
        if (!hotel) {
            return res.status(404).json({
                success: false,
                message: `Hotel not found with id of ${req.params.hotelId}`
            });
        }

        const roomType = await RoomType.findOne({
            _id: req.params.roomTypeId,
            hotel: req.params.hotelId
        });

        if (!roomType) {
            return res.status(404).json({
                success: false,
                message: `Room type not found with id of ${req.params.roomTypeId}`
            });
        }

        res.status(200).json({
            success: true,
            data: roomType
        });
    } catch (err) {
        return sendErrorResponse(res, err, 'Cannot find room type');
    }
};

// @desc    Create new room type for a hotel
// @route   POST /api/v1/hotels/:hotelId/room-types
// @access  Private (Admin)
exports.createRoomType = async (req, res, next) => {
    try {
        const allowedFields = [
            'name',
            'basePriceSatang',
            'amenities',
            'totalCapacity',
            'active'
        ];

        if (
            !req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).some((field) => !allowedFields.includes(field))
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Provide only allowed fields: name, basePriceSatang, amenities, totalCapacity, active'
            });
        }

        const roomType = await withInventoryTransaction(
            { hotelIds: [req.params.hotelId] },
            async (session) => {
                const [created] = await RoomType.create(
                    [
                        {
                            ...req.body,
                            hotel: req.params.hotelId
                        }
                    ],
                    { session }
                );
                return created;
            }
        );

        res.status(201).json({
            success: true,
            data: roomType
        });
    } catch (err) {
        return sendErrorResponse(res, err, 'Cannot create room type');
    }
};

// @desc    Update room type for a hotel
// @route   PUT /api/v1/hotels/:hotelId/room-types/:roomTypeId
// @access  Private (Admin)
exports.updateRoomType = async (req, res, next) => {
    try {
        const allowedFields = [
            'name',
            'basePriceSatang',
            'amenities',
            'totalCapacity',
            'active'
        ];

        if (
            !req.body ||
            typeof req.body !== 'object' ||
            Array.isArray(req.body) ||
            Object.keys(req.body).length === 0 ||
            Object.keys(req.body).some((field) => !allowedFields.includes(field))
        ) {
            return res.status(400).json({
                success: false,
                message:
                    'Provide at least one of: name, basePriceSatang, amenities, totalCapacity, active'
            });
        }

        if (!mongoose.isObjectIdOrHexString(req.params.roomTypeId)) {
            return res.status(400).json({
                success: false,
                message: 'Room type id must be a valid ObjectId'
            });
        }

        const roomType = await withInventoryTransaction(
            { hotelIds: [req.params.hotelId] },
            async (session) => {
                const existing = await RoomType.findOne({
                    _id: req.params.roomTypeId,
                    hotel: req.params.hotelId
                }).session(session);

                if (!existing) {
                    throw createAppError(
                        `Room type not found with id of ${req.params.roomTypeId}`,
                        404,
                        'ROOM_TYPE_NOT_FOUND'
                    );
                }

                existing.set(req.body);
                await existing.validate();

                // Check capacity against booked rooms from today (Asia/Bangkok) onwards
                if (Object.hasOwn(req.body, 'totalCapacity')) {
                    const todayBangkok = getBangkokTodayDate();
                    const overbookedNight = await RoomInventory.findOne({
                        hotel: req.params.hotelId,
                        roomType: existing._id,
                        date: { $gte: todayBangkok },
                        bookedRooms: { $gt: existing.totalCapacity }
                    }).session(session);

                    if (overbookedNight) {
                        throw createAppError(
                            'Cannot reduce totalCapacity below existing booked rooms from today onwards',
                            409,
                            'CAPACITY_BELOW_BOOKED'
                        );
                    }
                }

                await existing.save({ session });
                return existing;
            }
        );

        res.status(200).json({
            success: true,
            data: roomType
        });
    } catch (err) {
        return sendErrorResponse(res, err, 'Cannot update room type');
    }
};

// @desc    Soft-delete (deactivate) room type for a hotel
// @route   DELETE /api/v1/hotels/:hotelId/room-types/:roomTypeId
// @access  Private (Admin)
exports.deleteRoomType = async (req, res, next) => {
    try {
        if (!mongoose.isObjectIdOrHexString(req.params.roomTypeId)) {
            return res.status(400).json({
                success: false,
                message: 'Room type id must be a valid ObjectId'
            });
        }

        const roomType = await withInventoryTransaction(
            { hotelIds: [req.params.hotelId] },
            async (session) => {
                const existing = await RoomType.findOne({
                    _id: req.params.roomTypeId,
                    hotel: req.params.hotelId
                }).session(session);

                if (!existing) {
                    throw createAppError(
                        `Room type not found with id of ${req.params.roomTypeId}`,
                        404,
                        'ROOM_TYPE_NOT_FOUND'
                    );
                }

                existing.active = false;
                await existing.save({ session });
                return existing;
            }
        );

        res.status(200).json({
            success: true,
            data: roomType
        });
    } catch (err) {
        return sendErrorResponse(res, err, 'Cannot delete room type');
    }
};
