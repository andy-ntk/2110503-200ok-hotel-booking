const User = require('../models/User.js');

//@descC Register user
//@route POST /api/vl/auth/register
//@access Public
exports.register = async (req, res, next) => {
    try {
        const { name, email, password, role } = req.body;

        //Create user
        const user = await User.create({
            name,
            email,
            password,
            role
        });
        res.status(201).json({success: true});
    } catch (err) {
        res.status(400).json({ success: false });
        console.log(err.stack);
    }

}