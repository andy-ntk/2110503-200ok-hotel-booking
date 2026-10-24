const express = require('express');
const dotenv = require('dotenv');

// โหลดตัวแปรจาก config.env
dotenv.config({ path: './config/config.env' });

const connectDB = require('./config/db');

// Routes files
const hotels = require('./routes/hotels');
const auth = require('./routes/auth');

const app = express();

// Body Parser ให้ Express อ่าน JSON ได้
app.use(express.json());

// Mount routers
app.use('/api/v1/hotels', hotels);
app.use('/api/v1/auth',auth);

// เส้นทางทดสอบเบื้องต้น
app.get('/', (req, res) => {
    res.status(200).json({ success: true, message: 'Hotel Booking API is running' });
});

const PORT = process.env.PORT || 5003;

const startServer = async () => {
    try {
        await connectDB();

        app.listen(PORT, () => {
            console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
        });
    } catch (error) {
        console.error(`Failed to connect to MongoDB: ${error.message}`);
        process.exit(1);
    }
};

startServer();