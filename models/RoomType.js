const mongoose = require('mongoose');

const isNonNegativeInteger = (value) => {
    return Number.isInteger(value) && value >= 0;
};

const isPositiveInteger = (value) => {
    return Number.isInteger(value) && value >= 1;
};

const isStringArray = (value) => {
    return (
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string' && item.trim().length > 0)
    );
};

const RoomTypeSchema = new mongoose.Schema({
    hotel: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Hotel',
        required: [true, 'Please add a hotel'],
        immutable: true,
        index: true
    },
    name: {
        type: String,
        required: [true, 'Please add a room type name'],
        trim: true,
        maxlength: [50, 'Name cannot be more than 50 characters']
    },
    basePriceSatang: {
        type: Number,
        required: [true, 'Please add a base price in satang'],
        validate: {
            validator: isNonNegativeInteger,
            message: 'basePriceSatang must be an integer greater than or equal to 0'
        }
    },
    amenities: {
        type: [String],
        default: [],
        validate: {
            validator: isStringArray,
            message: 'amenities must be an array of non-empty strings'
        }
    },
    totalCapacity: {
        type: Number,
        required: [true, 'Please add total capacity'],
        validate: {
            validator: isPositiveInteger,
            message: 'totalCapacity must be an integer greater than or equal to 1'
        }
    },
    active: {
        type: Boolean,
        default: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

RoomTypeSchema.index({ hotel: 1, active: 1 });

module.exports = mongoose.model('RoomType', RoomTypeSchema);
