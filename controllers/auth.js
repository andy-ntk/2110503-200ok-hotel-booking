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
        const token = user.getSignedJwtToken();
        res.status(201).json({success: true , token});
    } catch (err) {
        res.status(400).json({ success: false });
        console.log(err.stack);
    }

}

//@desc Login User
//@route POST /api/v1/auth/login
//@access Public
exports.login = async (req, res, next) => {
    const { email, password } = req.body;

    //Validate Email & Password
    if (!email || !password) {
        return req.status(400).json({ success: false, msg: 'Please provide an email and password' });
    }

    //Check for user
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
        return res.status(400).json({ success: false, msg: 'Invalid credentials' });
    }

    //Check if password matches
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
        return res.status(401).json({ success: false, msg: 'Invalid credentials' });
    }

    //Crete token
    const token=user.getSignedJwtToken();

    res.status(200).json({success:true , token});

    // sendTokenRespond(user, 200, res);
}