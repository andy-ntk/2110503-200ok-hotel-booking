# Hotel Booking API Backend

> **2110503 Software Development Practice (2569/1)**  
> **Group: 200 OK** | **Project #1: Hotel Booking**

---

## Team Members

| No. | Student ID | Name | Role |
| :---: | :---: | :--- | :--- |
| 1 | 6731315721 | Natthakorn Yiengyongphan | Backend Developer |
| 2 | 6731341021 | Pusorn Ngamsanlert | Backend Developer |

---

## System Requirements

### 1. Functional Requirements (Core 9 Requirements)
1. **User Registration:** The system shall allow a user to register by specifying the name, telephone number, email, and password.
2. **User Authentication & Session:** After registration, the user becomes a registered user, and the system shall allow the user to log in using email and password, as well as log out of the system.
3. **Hotel Booking Creation:** After login, the system shall allow the registered user to book up to 3 nights by specifying the date and the preferred hotel. The hotel list (name, address, telephone number) is also provided.
4. **View Own Bookings:** The system shall allow the registered user to view his/her own hotel bookings.
5. **Edit Own Bookings:** The system shall allow the registered user to edit his/her own hotel bookings.
6. **Delete Own Bookings:** The system shall allow the registered user to delete his/her own hotel bookings.
7. **Admin View Bookings:** The system shall allow the admin to view any hotel bookings.
8. **Admin Edit Bookings:** The system shall allow the admin to edit any hotel bookings.
9. **Admin Delete Bookings:** The system shall allow the admin to delete any hotel bookings.

---

### 2. Non-Functional Requirements & Constraints
* **Security:** 
  * The system shall authenticate users using username/email and password.
  * The system shall be able to keep users' transactions confidential.
* **Performance:** The system shall respond to any request within 3 seconds.
* **Usability & Testing:** The system shall be tested and verified via Postman / Postman Runner / Newman.
* **Architecture:** Backend RESTful Web API (No frontend required).
* **Database:** MongoDB Atlas or Replica Set (Mongoose ODM with multi-document transactions).

---

### 3. Additional Requirements (Extra Credits — Group: 200 OK)
1. **Room Type Management:** The system shall allow the admin to manage multiple room types (e.g., Standard, Deluxe, Suite) with base price per night, room amenities, and total capacity for each hotel.
2. **Dynamic Pricing Rules:** The system shall calculate the final booking price using dynamic pricing rules (e.g., weekend surcharges and multi-night discounts).
3. **Real-time Capacity & Overbooking Prevention:** The system shall validate room availability in real time across the requested consecutive dates, decrement remaining capacity, and reject bookings with an overbooking error when capacity is full.
4. **Room Upgrade & Downgrade:** The system shall allow registered users to upgrade or downgrade their booked room type before the check-in date (if available) and automatically calculate the price difference.
5. **Admin Occupancy & Revenue Analytics:** The system shall provide an admin endpoint to view daily occupancy rates and generated revenue grouped by room type for each hotel.

---

## Tech Stack & Tools
* **Runtime:** Node.js
* **Framework:** Express.js
* **Database:** MongoDB Atlas / Replica Set & Mongoose
* **Authentication:** JSON Web Tokens (JWT) & bcryptjs
* **API Testing:** Node.js Test Runner (`node:test`) & Postman / Newman

---

## Getting Started

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/<your-username>/2110503-200ok-hotel-booking.git
cd 2110503-200ok-hotel-booking
npm install
```

### 2. Running MongoDB with Transaction Support (Replica Set)
Because inventory reservation, booking CRUD, and room capacity checks use **MongoDB Multi-Document Transactions**, your MongoDB instance must run as a **Replica Set** (MongoDB Atlas clusters support this by default).

To run a local single-node MongoDB Replica Set via Docker:
```bash
docker run -d --name mongo-rs -p 27017:27017 mongo:7 --replSet rs0
docker exec -it mongo-rs mongosh --eval "rs.initiate()"
```

### 3. Setup Environment Variables
Create a file at `./config/config.env` (refer to `./config/config.env.example`):
```env
PORT=5003
NODE_ENV=development
MONGO_URI=mongodb://127.0.0.1:27017/hotel-booking?replicaSet=rs0
JWT_SECRET=your_JWT_SECRET
JWT_EXPIRE=30d
JWT_COOKIE_EXPIRE=30
```

### 4. Run the Development Server & Tests
```bash
# Start development server
npm run dev

# Run unit & logic tests
npm test

# Run full integration & concurrency tests against a test Replica Set DB
TEST_MONGO_URI="mongodb://127.0.0.1:27017/hotel-booking-test?replicaSet=rs0" npm test
```

---

## Legacy Booking Migration Guide

Before enabling the new Room Type & Inventory features on an existing database with legacy `v1` bookings, migrate existing bookings using [`scripts/migrateBookings.js`](scripts/migrateBookings.js).

### 1. Prepare Manifest File (`manifest.json`)
Create room types for each hotel first, then prepare a JSON manifest mapping every existing booking to its `roomTypeId` and historical `nightlyPrices`:
```json
[
  {
    "bookingId": "670000000000000000000101",
    "roomTypeId": "670000000000000000000011",
    "nightlyPrices": [
      { "date": "2026-11-06", "amountSatang": 100000 },
      { "date": "2026-11-07", "amountSatang": 120000 }
    ]
  }
]
```

### 2. Run Dry-Run Validation
```bash
node scripts/migrateBookings.js --manifest ./manifest.json --dry-run
```

### 3. Apply Migration (Idempotent)
Back up the database and stop the API server before applying:
```bash
node scripts/migrateBookings.js --manifest ./manifest.json --apply
```
