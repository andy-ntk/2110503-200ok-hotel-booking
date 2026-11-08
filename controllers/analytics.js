const { getHotelAnalytics } = require('../services/analyticsService');

// @route GET /api/v1/hotels/:hotelId/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
// @access Private (Admin)
exports.getAnalytics = async (req, res) => {
    try {
        const data = await getHotelAnalytics({
            hotelId: req.params.hotelId,
            from: req.query.from,
            to: req.query.to,
            roomType: req.query.roomType
        });
        return res.status(200).json({ success: true, data });
    } catch (err) {
        return res.status(err.statusCode || 500).json({
            success: false,
            message: err.statusCode ? err.message : 'Cannot get hotel analytics',
            code: err.code || 'ANALYTICS_ERROR'
        });
    }
};
