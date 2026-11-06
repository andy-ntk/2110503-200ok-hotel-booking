# แผนพัฒนา Additional Requirements 1–5
<!-- ชื่อไฟล์: ADDITIONAL-REQUIREMENTS-PLAN.md -->

## 1. การแบ่งงานและ Branch/PR

พัฒนาต่อจาก booking CRUD เดิม โดย merge PR #3 เข้า `main` ก่อนเริ่มงานใหม่

| เจ้าของ | Branch | งานใน PR |
|---|---|---|
| Hill | `feature/room-types-pricing-capacity` | ข้อ 1–3, contract กลาง, ปรับ booking CRUD, migration และ tests ของส่วนนี้ |
| เรา | `feature/room-change-analytics` | ข้อ 4–5, Postman, integration tests รวมข้อ 1–5 และ CI |

มี **2 branch และ 2 PR ใหม่** โดยรวมเอกสาร contract และการทดสอบไว้ใน PR ที่เกี่ยวข้อง

### PR แรก: Hill ทำข้อ 1–3

หลัง booking CRUD merge แล้ว:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/room-types-pricing-capacity
```

ลำดับ commit ที่แนะนำ:

1. บันทึก contract และเพิ่ม model
2. เพิ่ม Room Type Management
3. เพิ่ม pricing service
4. เพิ่ม inventory service และเชื่อม booking CRUD
5. เพิ่ม migration, tests และเอกสาร

เปิด PR เข้า `main` เมื่อข้อ 1–3 พร้อมทดสอบ รวม contract ที่ข้อ 4–5 ต้องใช้ไว้ใน PR นี้

### PR ที่สอง: เราทำข้อ 4–5

หลัง PR ของ Hill merge แล้ว:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/room-change-analytics
```

ลำดับ commit ที่แนะนำ:

1. เพิ่ม endpoint เปลี่ยนประเภทห้อง
2. เพิ่ม analytics
3. เพิ่ม Postman และ integration tests รวม
4. เชื่อม CI และปรับคู่มือใช้งาน

เปิด PR เดียวเข้า `main` เมื่อข้อ 4–5 และการทดสอบรวมพร้อม

## 2. Contract และกติกากลาง

### ข้อมูลพื้นฐาน

- หนึ่ง booking จองหนึ่งห้อง พักได้ 1–3 คืนตามข้อกำหนดเดิม
- ช่วงเข้าพักคือ `[checkIn, checkOut)` โดยไม่นับคืน check-out
- รับวันที่เป็น `YYYY-MM-DD` และเก็บเป็น UTC midnight ตามโค้ดเดิม
- เงื่อนไขก่อนวัน check-in ใช้วันปัจจุบันใน `Asia/Bangkok`
- เงินใช้จำนวนเต็มหน่วยสตางค์ สกุล THB และคำนวณฝั่ง server
- รายได้รายวันนับตามคืนเข้าพัก เป็นมูลค่า booking ที่ยังอยู่ในระบบ ไม่มีการรับหรือคืนเงินจริง

### Model

| Model | ข้อมูล |
|---|---|
| `RoomType` | `hotel`, `name`, `basePriceSatang`, `amenities`, `totalCapacity`, `active` |
| `Booking` | เพิ่ม `roomType`, `nightlyPrices`, `totalPriceSatang`, `pricingRuleVersion`, `schemaVersion: 2` |
| `RoomInventory` | `hotel`, `roomType`, `date`, `bookedRooms` |
| `Hotel` | เพิ่ม `inventoryVersion` เพื่อควบคุมการแก้ inventory พร้อมกัน |

`nightlyPrices` เป็นรายการ `{ date, amountSatang }` ครบทุกคืน โดย `totalPriceSatang` เท่ากับผลรวมเสมอ ราคาที่บันทึกแล้วไม่เปลี่ยนตามการแก้ราคาฐานภายหลัง

สร้าง unique index ของ inventory บน `(hotel, roomType, date)` และ index ของ booking บน `(hotel, roomType, checkIn, checkOut)`

### Service กลางที่ Hill ต้องส่งต่อ

```text
quoteStay({ roomTypeId, checkIn, checkOut, session })
  → { nightlyPrices, totalPriceSatang, pricingRuleVersion }

withInventoryTransaction({ hotelIds }, callback)

reserveStay({ hotelId, roomTypeId, checkIn, checkOut, session })

releaseStay({ hotelId, roomTypeId, checkIn, checkOut, session })
```

- การเปลี่ยน inventory และ booking ต้องอยู่ใน transaction เดียวกัน
- ภายใน transaction ให้แก้ `Hotel.inventoryVersion` ก่อนอ่านและแก้ inventory เพื่อป้องกันคำขอพร้อมกันใช้จำนวนห้องเก่า
- การสร้าง/แก้/ปิดประเภทห้อง และการลบโรงแรมต้องใช้กลไกเดียวกันเมื่อกระทบ inventory
- หากเกี่ยวข้องหลายโรงแรม ให้เรียง hotel ID ก่อนล็อกทุกครั้ง
- เมื่อ transaction ขัดแย้งชั่วคราว ให้ retry ทั้งรายการสูงสุด 3 ครั้ง หากยังไม่สำเร็จให้ตอบ `409`
- ตรวจข้อมูลและสิทธิ์จากข้อมูลล่าสุดภายใน transaction ทุกครั้ง
- ไม่รับราคา ยอดรวม หรือจำนวนห้องคงเหลือจาก client

Response ใช้รูปแบบเดิม `{ success, data }` ส่วน error ของฟีเจอร์ใหม่เพิ่ม `code` เช่น `CAPACITY_FULL` และ `CHECK_IN_STARTED`

## 3. PR ของ Hill: Additional Requirements 1–3

### ข้อ 1 — Room Type Management

เพิ่ม endpoint:

```text
GET    /api/v1/hotels/:hotelId/room-types
GET    /api/v1/hotels/:hotelId/room-types/:roomTypeId
POST   /api/v1/hotels/:hotelId/room-types
PUT    /api/v1/hotels/:hotelId/room-types/:roomTypeId
DELETE /api/v1/hotels/:hotelId/room-types/:roomTypeId
```

พฤติกรรม:

- อ่านข้อมูลได้แบบเดียวกับข้อมูลโรงแรม ส่วนเพิ่ม/แก้/ลบใช้สิทธิ์ admin
- ราคาฐานเป็นจำนวนเต็มตั้งแต่ศูนย์ และ capacity เป็นจำนวนเต็มตั้งแต่หนึ่ง
- ประเภทห้องต้องเป็นของโรงแรมใน URL จริง
- `DELETE` เปลี่ยนเป็น `active=false` เพื่อเก็บ reference และรายงานย้อนหลัง
- ประเภทห้อง inactive รับ booking ใหม่หรือเป็นเป้าหมายการเปลี่ยนห้องไม่ได้ แต่ booking เดิมยังอยู่และเปลี่ยนออกได้
- ลด capacity ได้เมื่อไม่ต่ำกว่าจำนวนห้องที่ถูกจองในทุกคืนตั้งแต่วันนี้ตามเวลาไทย ตรวจและแก้ใน transaction เดียวกัน

### ข้อ 2 — Dynamic Pricing

ใช้กติกาเริ่มต้น `v1`:

- คืนวันเสาร์และอาทิตย์เพิ่มราคาฐาน 20%
- พักครบ 3 คืนลด 10% หลังคิด weekend surcharge
- คำนวณแต่ละคืนตามลำดับ surcharge → discount → ปัดเป็นสตางค์แบบครึ่งขึ้น แล้วรวมยอด
- เก็บกติกาใน pricing module เดียว ยังไม่เพิ่ม API จัดการกติกา

เพิ่ม `roomType` ใน request สร้าง booking และให้ server คำนวณ `nightlyPrices`, `totalPriceSatang` และ `pricingRuleVersion`

### ข้อ 3 — Capacity และ Booking CRUD

- สร้าง booking: จอง inventory ทุกคืนพร้อมสร้าง booking หากคืนใดเต็มให้ rollback ทั้งรายการและตอบ `409 CAPACITY_FULL`
- แก้วันผ่าน `PUT` เดิม: คืน inventory เดิม จองช่วงใหม่ และคำนวณราคาใหม่ใน transaction เดียว
- ย้ายโรงแรมผ่าน `PUT` เดิม: ต้องส่ง `roomType` ของโรงแรมใหม่ด้วย และจัดการ inventory ทั้งสองโรงแรมพร้อมกัน
- เปลี่ยนประเภทห้องภายในโรงแรมเดิม: ใช้ endpoint ข้อ 4 เพื่อไม่ให้ข้ามเงื่อนไขก่อน check-in
- ลบ booking: คืน inventory และลบ booking พร้อมกัน จำนวนห้องต้องไม่ติดลบ
- ลบโรงแรม: ลบ booking, room types, inventory และโรงแรมใน transaction เดียว แทน cascade เดิม
- หลายคำขอจองห้องสุดท้ายพร้อมกันต้องสำเร็จได้ไม่เกิน capacity จริง

### เกณฑ์พร้อม Merge

- Contract และ service กลางใช้งานได้ตามที่กำหนด
- สร้าง/แก้/ลบ booking ใช้ inventory จริงครบทุกเส้นทาง
- Pricing, concurrency และ rollback มีผลทดสอบ
- Migration มี dry-run และคู่มือใช้งาน
- ระบุวิธีรัน MongoDB ที่รองรับ transaction

## 4. PR ของเรา: Additional Requirements 4–5

### ข้อ 4 — Room Upgrade & Downgrade

เพิ่ม endpoint:

```text
PATCH /api/v1/bookings/:id/room-type
```

Request:

```json
{
  "roomType": "<targetRoomTypeId>"
}
```

พฤติกรรม:

- เจ้าของ booking หรือ admin ทำรายการได้
- เปลี่ยนได้เฉพาะก่อนวัน check-in ตามเวลาไทย
- ประเภทเป้าหมายต้อง active และอยู่โรงแรมเดิม โดยไม่เปลี่ยนวันเข้าพัก
- ใช้ service กลางของ Hill สำหรับราคาและ inventory
- ภายใน transaction ให้อ่าน booking ล่าสุด ตรวจสิทธิ์และวัน จองประเภทใหม่ คืนประเภทเดิม และบันทึกราคาใหม่
- คิดราคาทั้งช่วงพักตามกติกาปัจจุบัน แล้วเทียบกับยอดเดิมที่บันทึกไว้
- หากประเภทใหม่เต็มหรือบันทึกไม่สำเร็จ ข้อมูลและ inventory เดิมต้องอยู่ครบ
- เลือกประเภทเดิมก่อนวัน check-in ให้ตอบสำเร็จ ส่วนต่างศูนย์ และไม่คิดราคาใหม่

Response สำเร็จมี booking ล่าสุด พร้อม:

```text
previousTotalPriceSatang
newTotalPriceSatang
priceDifferenceSatang = newTotal − previousTotal
```

ส่วนต่างบวกหมายถึงยอดเพิ่ม ส่วนต่างลบหมายถึงยอดลด โดยยังไม่เชื่อมระบบชำระเงิน

สถานะ error:

| HTTP | กรณี |
|---|---|
| `400` | input ผิดหรือประเภทห้องไม่ตรงโรงแรม |
| `401` | ไม่ได้เข้าสู่ระบบ |
| `403` | ไม่มีสิทธิ์ |
| `404` | ไม่พบ booking หรือประเภทห้อง |
| `409` | ห้องเต็ม ถึงวัน check-in หรือ transaction ขัดแย้งหลัง retry |

### ข้อ 5 — Admin Occupancy & Revenue Analytics

เพิ่ม endpoint:

```text
GET /api/v1/hotels/:hotelId/analytics
    ?from=YYYY-MM-DD
    &to=YYYY-MM-DD
    &roomType=<optionalId>
```

พฤติกรรม:

- เฉพาะ admin
- ต้องระบุ `from` และ `to` โดยรวมทั้งสองวัน และไม่เกิน 31 วันต่อคำขอ
- ส่งหนึ่งแถวต่อวันต่อประเภทห้อง รวมวันที่ไม่มี booking
- แต่ละแถวมี `date`, `roomType`, `capacity`, `bookedRooms`, `availableRooms`, `occupancyRate`, `revenueSatang`
- `availableRooms = capacity − bookedRooms`
- `occupancyRate = bookedRooms / capacity × 100` ปัดสองตำแหน่ง
- รายได้รวมจาก `nightlyPrices` ของคืนนั้น ห้ามนับยอดรวมทั้ง booking ซ้ำทุกวัน
- ใช้ capacity ปัจจุบันเป็นฐาน พร้อมระบุ `capacityBasis: "current"` ใน response
- รวมประเภทห้อง inactive เพื่อให้ booking เดิมปรากฏในรายงาน
- Booking ที่ถูกลบไม่นับ วันที่อนาคตสะท้อนยอดจองล่วงหน้า
- อ่านข้อมูลด้วย snapshot เดียวเพื่อให้จำนวนห้องและรายได้สอดคล้องกัน

## 5. Migration, Tests และการส่งงาน

### Migration Booking เดิม

Hill ทำ script รองรับ dry-run และ apply โดยรับ manifest:

```text
bookingId
roomTypeId
nightlyPrices: [{ date, amountSatang }]
```

ขั้นตอน:

1. สร้างประเภทห้องของแต่ละโรงแรม
2. ระบุประเภทห้องและราคาที่ถูกต้องให้ booking เดิมทุกตัว ไม่เดาราคาย้อนหลังจากราคาปัจจุบัน
3. Dry-run ตรวจข้อมูลครบทุกคืน ประเภทห้องตรงโรงแรม ราคาไม่ติดลบ และยอดจองไม่เกิน capacity
4. สำรองฐานข้อมูลและหยุด API ก่อน apply
5. เติมข้อมูล booking และสร้าง inventory ด้วย transaction แยกต่อโรงแรม
6. ตรวจจำนวน booking เท่าเดิม ราคาตรงกับผลรวมรายคืน และ inventory ตรงกับ booking
7. เปิดระบบใหม่เมื่อทุกโรงแรมผ่าน migration และการตรวจสอบ

Script ต้องรันซ้ำได้โดยไม่เพิ่ม inventory ซ้ำ และรายงานรายการที่ขาดข้อมูลหรือขัดแย้ง ห้ามเปิดฟีเจอร์ใหม่หาก migration ยังไม่ครบ

### ความรับผิดชอบด้าน Tests

| เจ้าของ | งาน |
|---|---|
| Hill | Tests ของ room types, pricing, inventory, migration และ rollback ข้อ 1–3 |
| เรา | Tests ของการเปลี่ยนห้อง analytics และ regression ของ booking CRUD |
| เรา | Postman/Newman และ integration รวมข้อ 1–5 |

ใช้ `node:test` สำหรับ logic และ concurrency ส่วน Postman/Newman ใช้ทดสอบ API workflow พร้อม assertions ทุกการทดสอบใช้ฐานข้อมูลแยกที่รองรับ MongoDB transactions

### กรณีที่ต้องผ่าน

- ราคาวันธรรมดา วันหยุด ช่วงผสม ส่วนลด 3 คืน และการปัดสตางค์
- การพักซ้อนกันบางคืน และ booking ต่อกันตรงวัน check-out
- จองห้องสุดท้ายพร้อมกัน รวมถึงเปลี่ยนห้องพร้อมกับมีคนจองประเภทเป้าหมาย
- เปลี่ยนห้องสำเร็จแล้วห้องเดิมว่างและส่วนต่างถูกต้อง
- เปลี่ยนห้องไม่สำเร็จแล้ว booking ราคา และ inventory เดิมอยู่ครบ
- ก่อนและหลังเที่ยงคืนวัน check-in ตาม `Asia/Bangkok` โดยใช้ clock จำลอง
- แก้วัน ย้ายโรงแรม ลบ booking และลบโรงแรมแล้ว inventory ถูกต้อง
- Analytics ตรงกับข้อมูลที่คำนวณมือ รวมคืน check-out วันว่าง ส่วนลด การเปลี่ยนห้อง และการลบ booking
- ผู้ใช้อื่นแก้ booking ไม่ได้ และ user ปกติดู analytics ไม่ได้
- Migration ข้อมูลไม่ครบหรือเกิน capacity ต้องไม่ทิ้งข้อมูลครึ่งรายการ
- Migration รันซ้ำแล้วไม่สร้างยอดจองซ้ำ

### CI และเกณฑ์จบงาน

- เพิ่มคำสั่งทดสอบจริงแทน `npm test` ที่ยังเป็น placeholder
- CI รัน syntax check ทีละไฟล์, logic/integration tests และ Newman บน MongoDB แบบ replica set
- แต่ละ PR มีตัวอย่าง request ผลทดสอบ และ requirement ที่ทำสำเร็จ
- README และ Postman อธิบายวิธีตั้งค่า migration และสาธิตระบบครบ
- ทดสอบเส้นทางรวม: สร้างประเภทห้อง → จองพร้อมคิดราคา → เปลี่ยนห้อง → ดู analytics → ลบ booking → ตรวจคืน inventory

งานเสร็จเมื่อทั้งสอง PR ผ่านการทดสอบ ข้อมูลเดิม migrate ครบ และสาธิตข้อ 1–5 ได้โดยไม่ต้องแก้โค้ดเพิ่มเติม

### สมมติฐานที่ใช้

- Backend API เท่านั้น ไม่มี frontend
- หนึ่ง booking จองหนึ่งห้อง
- ราคาเป็น THB หน่วยสตางค์
- Weekend surcharge 20% และส่วนลดพัก 3 คืน 10% เป็นค่าเริ่มต้น
- Analytics แสดงมูลค่าการจองตามคืนพัก ไม่มีระบบรับเงินจริงหรือบัญชีรายได้
- ใช้ capacity ปัจจุบันสำหรับรายงาน ยังไม่ทำประวัติ capacity
- MongoDB ต้องรองรับ transactions
