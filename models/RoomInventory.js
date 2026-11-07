const mongoose = require('mongoose');
const { parseBookingDate, isCalendarDate } = require('../utils/date');

const isNonNegativeInteger = (value) => {
    return Number.isInteger(value) && value >= 0;
};

const RoomInventorySchema = new mongoose.Schema({
    hotel: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hotel',
        required: true,
        index: true
    },
    roomType: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RoomType',
        required: true,
        index: true
    },
    date: {
        type: Date,
        required: true,
        set: parseBookingDate,
        validate: {
            validator: isCalendarDate,
            message: 'Inventory date must be a calendar date at midnight UTC'
        }
    },
    bookedRooms: {
        type: Number,
        required: true,
        default: 0,
        validate: {
            validator: isNonNegativeInteger,
            message: 'bookedRooms must be an integer greater than or equal to 0'
        }
    }
});

RoomInventorySchema.index({ hotel: 1, roomType: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('RoomInventory', RoomInventorySchema);
