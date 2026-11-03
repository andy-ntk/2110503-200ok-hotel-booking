const express = require('express');
const {protect , authorize} = require('../middleware/auth');

// Include other resource routers
const bookingRouter = require('./bookings');

const {
    getHotels,
    getHotel,
    createHotel,
    updateHotel,
    deleteHotel
} = require('../controllers/hotels');

const router = express.Router();

// Re-route into other resource routers
router.use('/:hotelId/bookings', bookingRouter);

router.route('/')
    .get(getHotels)
    .post(protect, authorize('admin'),createHotel);
    
router.route('/:id')
    .get(getHotel)
    .put(protect,authorize('admin'),updateHotel)
    .delete(protect,authorize('admin'),deleteHotel);

module.exports = router;