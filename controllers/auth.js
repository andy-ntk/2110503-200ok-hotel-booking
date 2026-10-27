const User = require('../models/User.js');

//Get token from model, crete cookie and send respond
const sendTokenRespond = (user, statusCode, res) => {
    //crete token
    const token = user.getSignedJwtToken();

    const options = {
        expires: new Date(Date.now() + process.env.JWT_COOKIE_EXPIRE * 24 * 60 * 60 * 1000),
        httpOnly: true
    }

    if (process.env.NODE_ENV === 'production') {
        options.secure = true;
    }
    res.status(statusCode).cookie('token', token, options).json({
        success: true,
        //add for frontend
        _id: user._id,
        name: user.name,
        email: user.email,
        //end for frontend
        token
    })
}

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
        sendTokenRespond(user, 200, res);
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

    if (!req.body || Object.keys(req.body).length === 0) {
        return res.status(400).json({ success: false, msg: 'Please provide request body' });
    }
    //Validate Email & Password
    if (!email || !password) {
        return res.status(400).json({ success: false, msg: 'Please provide an email and password' });
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

    sendTokenRespond(user, 200, res);
}

exports.getMe = async (req, res, next) => {
    const user = await User.findById(req.user.id);
    res.status(200).json({
        success: true,
        data: user
    });
};

//@desc Log user out / clear cookie
//@route GET /api/v1/auth/logout
//@access Private
exports.logout = async (req, res, next) => {
  res.cookie("token", "none", {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({
    success: true,
    data: {},
  });
};