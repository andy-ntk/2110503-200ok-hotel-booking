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
* **Database:** MongoDB Atlas (Mongoose ODM).

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
* **Database:** MongoDB Atlas & Mongoose
* **Authentication:** JSON Web Tokens (JWT) & bcryptjs
* **API Testing:** Postman / Postman Collection Runner / Newman

---

## Getting Started

### 1. Clone & Install Dependencies
```bash
git clone [https://github.com/](https://github.com/)<your-username>/2110503-200ok-hotel-booking.git
cd 2110503-200ok-hotel-booking
npm install
```

### 2. Setup Environment Variables
Create a file at `./config/config.env` (refer to `./config/config.env.example`):
```env
PORT=5003
NODE_ENV=development
MONGO_URI=your_mongodb_connection_string
```

### 3. Run the Development Server
```bash
npm run dev
```