const express = require('express');
const {
    getHotels,
    getHotel,
    createHotel,
    updateHotel,
    deleteHotel
} = require('../controllers/hotels');

const router = express.Router();

router.route('/')
    .get(getHotels)
    .post(createHotel);
    
router.route('/:id')
    .get(getHotel)
    .put(updateHotel)
    .delete(deleteHotel);

module.exports = router;