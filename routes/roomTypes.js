const express = require('express');
const {
    getRoomTypes,
    getRoomType,
    createRoomType,
    updateRoomType,
    deleteRoomType
} = require('../controllers/roomTypes');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router
    .route('/')
    .get(getRoomTypes)
    .post(protect, authorize('admin'), createRoomType);

router
    .route('/:roomTypeId')
    .get(getRoomType)
    .put(protect, authorize('admin'), updateRoomType)
    .delete(protect, authorize('admin'), deleteRoomType);

module.exports = router;
