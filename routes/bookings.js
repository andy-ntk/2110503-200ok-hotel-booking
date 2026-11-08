const express = require('express');

const { getBookings, getBooking, addBooking, updateBooking, deleteBooking, changeRoomType } = require('../controllers/bookings');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.patch('/:id/room-type', protect, authorize('admin', 'user'), changeRoomType);

router.route('/')
    .get(protect, getBookings)
    .post(protect, authorize('admin', 'user'), addBooking);

router.route('/:id')
    .get(protect, getBooking)
    .put(protect, authorize('admin', 'user'), updateBooking)
    .delete(protect, authorize('admin', 'user'), deleteBooking);

module.exports = router;
