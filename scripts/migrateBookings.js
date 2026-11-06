const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Hotel = require('../models/Hotel');
const RoomType = require('../models/RoomType');
const Booking = require('../models/Booking');
const RoomInventory = require('../models/RoomInventory');
const {
    parseBookingDate,
    isCalendarDate,
    formatDateYMD,
    enumerateStayDates
} = require('../utils/date');
const {
    createAppError,
    withInventoryTransaction
} = require('../services/inventoryService');

const normalizeManifestEntries = (manifestInput) => {
    if (Array.isArray(manifestInput)) {
        return manifestInput;
    }
    if (
        manifestInput &&
        typeof manifestInput === 'object' &&
        Array.isArray(manifestInput.bookings)
    ) {
        return manifestInput.bookings;
    }
    throw createAppError(
        'Manifest must be an array of booking migration entries or an object with a bookings array',
        400,
        'INVALID_MANIFEST_FORMAT'
    );
};

const isBookingAlreadyMigrated = (rawBooking) => {
    return (
        rawBooking.schemaVersion === 2 &&
        rawBooking.roomType &&
        Array.isArray(rawBooking.nightlyPrices) &&
        rawBooking.nightlyPrices.length > 0 &&
        Number.isInteger(rawBooking.totalPriceSatang) &&
        rawBooking.totalPriceSatang >= 0
    );
};

const validateAndNormalizeNightlyPrices = (nightlyPrices, expectedDates) => {
    if (!Array.isArray(nightlyPrices) || nightlyPrices.length !== expectedDates.length) {
        return {
            valid: false,
            reason: `nightlyPrices must have exactly ${expectedDates.length} night(s)`
        };
    }

    const byDateMs = new Map();
    for (const item of nightlyPrices) {
        if (!item || typeof item !== 'object') {
            return { valid: false, reason: 'Invalid nightlyPrice entry' };
        }

        let parsedDate;
        try {
            parsedDate = parseBookingDate(
                item.date instanceof Date ? formatDateYMD(item.date) : item.date
            );
        } catch (err) {
            return { valid: false, reason: err.message };
        }

        if (!isCalendarDate(parsedDate)) {
            return {
                valid: false,
                reason: 'Each nightlyPrice date must be a valid calendar date'
            };
        }

        if (!Number.isInteger(item.amountSatang) || item.amountSatang < 0) {
            return {
                valid: false,
                reason: 'Each nightlyPrice amountSatang must be a non-negative integer'
            };
        }

        if (byDateMs.has(parsedDate.getTime())) {
            return {
                valid: false,
                reason: 'Duplicate date in nightlyPrices'
            };
        }

        byDateMs.set(parsedDate.getTime(), {
            date: parsedDate,
            amountSatang: item.amountSatang
        });
    }

    const normalized = [];
    let totalPriceSatang = 0;

    for (const expectedDate of expectedDates) {
        const entry = byDateMs.get(expectedDate.getTime());
        if (!entry) {
            return {
                valid: false,
                reason: `Missing nightlyPrice for stay night ${formatDateYMD(expectedDate)}`
            };
        }
        normalized.push(entry);
        totalPriceSatang += entry.amountSatang;
    }

    return {
        valid: true,
        nightlyPrices: normalized,
        totalPriceSatang
    };
};

const migrateBookings = async ({
    manifest,
    mode = 'dry-run',
    defaultPricingRuleVersion = 'v1'
} = {}) => {
    if (mode !== 'dry-run' && mode !== 'apply') {
        throw createAppError(
            'Migration mode must be either "dry-run" or "apply"',
            400,
            'INVALID_MIGRATION_MODE'
        );
    }

    const entries = normalizeManifestEntries(manifest);
    const errors = [];

    const manifestByBookingId = new Map();
    for (const entry of entries) {
        if (!entry || !entry.bookingId) {
            errors.push({
                code: 'INVALID_MANIFEST_ENTRY',
                bookingId: null,
                message: 'Manifest entry is missing bookingId'
            });
            continue;
        }

        const key = entry.bookingId.toString();
        if (manifestByBookingId.has(key)) {
            errors.push({
                code: 'DUPLICATE_MANIFEST_BOOKING',
                bookingId: key,
                message: `Duplicate manifest entry for booking ${key}`
            });
            continue;
        }

        manifestByBookingId.set(key, entry);
    }

    const rawBookings = await Booking.collection.find({}).toArray();
    const hotels = await Hotel.find({}).lean();
    const roomTypes = await RoomType.find({}).lean();

    const hotelById = new Map(hotels.map((h) => [h._id.toString(), h]));
    const roomTypeById = new Map(roomTypes.map((rt) => [rt._id.toString(), rt]));
    const rawBookingById = new Map(
        rawBookings.map((b) => [b._id.toString(), b])
    );

    // Ensure every manifest bookingId exists in DB
    for (const [bookingId] of manifestByBookingId.entries()) {
        if (!rawBookingById.has(bookingId)) {
            errors.push({
                code: 'BOOKING_NOT_FOUND',
                bookingId,
                message: `Manifest references non-existent booking ${bookingId}`
            });
        }
    }

    const plannedUpdatesByHotel = new Map();

    for (const rawBooking of rawBookings) {
        const bookingId = rawBooking._id.toString();
        const hotelId = rawBooking.hotel ? rawBooking.hotel.toString() : null;

        if (!hotelId || !hotelById.has(hotelId)) {
            errors.push({
                code: 'HOTEL_NOT_FOUND',
                bookingId,
                message: `Booking ${bookingId} references missing hotel ${hotelId}`
            });
            continue;
        }

        let expectedDates;
        try {
            expectedDates = enumerateStayDates(
                rawBooking.checkIn instanceof Date
                    ? rawBooking.checkIn
                    : parseBookingDate(rawBooking.checkIn),
                rawBooking.checkOut instanceof Date
                    ? rawBooking.checkOut
                    : parseBookingDate(rawBooking.checkOut)
            );
        } catch (err) {
            errors.push({
                code: 'INVALID_BOOKING_DATES',
                bookingId,
                message: `Booking ${bookingId} has invalid dates: ${err.message}`
            });
            continue;
        }

        const manifestEntry = manifestByBookingId.get(bookingId);
        const alreadyMigrated = isBookingAlreadyMigrated(rawBooking);

        if (!manifestEntry && !alreadyMigrated) {
            errors.push({
                code: 'MISSING_MANIFEST_ENTRY',
                bookingId,
                message: `Legacy booking ${bookingId} is missing from migration manifest`
            });
            continue;
        }

        const targetRoomTypeId = manifestEntry
            ? (manifestEntry.roomTypeId || manifestEntry.roomType || '').toString()
            : rawBooking.roomType.toString();

        const roomType = roomTypeById.get(targetRoomTypeId);
        if (!roomType) {
            errors.push({
                code: 'ROOM_TYPE_NOT_FOUND',
                bookingId,
                roomTypeId: targetRoomTypeId,
                message: `Room type ${targetRoomTypeId} for booking ${bookingId} was not found`
            });
            continue;
        }

        if (roomType.hotel.toString() !== hotelId) {
            errors.push({
                code: 'ROOM_TYPE_HOTEL_MISMATCH',
                bookingId,
                hotelId,
                roomTypeId: targetRoomTypeId,
                message: `Room type ${targetRoomTypeId} does not belong to booking hotel ${hotelId}`
            });
            continue;
        }

        const sourceNightlyPrices = manifestEntry
            ? manifestEntry.nightlyPrices
            : rawBooking.nightlyPrices;

        const priceValidation = validateAndNormalizeNightlyPrices(
            sourceNightlyPrices,
            expectedDates
        );

        if (!priceValidation.valid) {
            errors.push({
                code: 'INVALID_NIGHTLY_PRICES',
                bookingId,
                message: `Booking ${bookingId}: ${priceValidation.reason}`
            });
            continue;
        }

        // If already migrated and also in manifest, ensure no conflict
        if (alreadyMigrated && manifestEntry) {
            const existingRoomTypeId = rawBooking.roomType.toString();
            const existingValidation = validateAndNormalizeNightlyPrices(
                rawBooking.nightlyPrices,
                expectedDates
            );

            const pricesMatch =
                existingValidation.valid &&
                existingValidation.totalPriceSatang ===
                    priceValidation.totalPriceSatang &&
                existingValidation.nightlyPrices.every(
                    (np, idx) =>
                        np.amountSatang ===
                        priceValidation.nightlyPrices[idx].amountSatang
                );

            if (existingRoomTypeId !== targetRoomTypeId || !pricesMatch) {
                errors.push({
                    code: 'ALREADY_MIGRATED_CONFLICT',
                    bookingId,
                    message: `Booking ${bookingId} is already migrated with different roomType or nightlyPrices`
                });
                continue;
            }
        }

        if (!plannedUpdatesByHotel.has(hotelId)) {
            plannedUpdatesByHotel.set(hotelId, []);
        }

        plannedUpdatesByHotel.get(hotelId).push({
            bookingId: rawBooking._id,
            hotelId: rawBooking.hotel,
            roomTypeId: roomType._id,
            roomTypeCapacity: roomType.totalCapacity,
            nightlyPrices: priceValidation.nightlyPrices,
            totalPriceSatang: priceValidation.totalPriceSatang,
            pricingRuleVersion:
                (manifestEntry && manifestEntry.pricingRuleVersion) ||
                rawBooking.pricingRuleVersion ||
                defaultPricingRuleVersion,
            stayDates: expectedDates
        });
    }

    // Validate capacity per (hotel, roomType, date)
    const inventoryPlanByHotel = new Map();

    for (const [hotelId, bookingPlans] of plannedUpdatesByHotel.entries()) {
        const countByRoomTypeAndDate = new Map();

        for (const plan of bookingPlans) {
            const rtIdStr = plan.roomTypeId.toString();
            for (const date of plan.stayDates) {
                const key = `${rtIdStr}:${date.getTime()}`;
                const existing = countByRoomTypeAndDate.get(key) || {
                    hotel: new mongoose.Types.ObjectId(hotelId),
                    roomType: plan.roomTypeId,
                    roomTypeCapacity: plan.roomTypeCapacity,
                    date,
                    bookedRooms: 0
                };
                existing.bookedRooms += 1;
                countByRoomTypeAndDate.set(key, existing);
            }
        }

        const inventoryDocs = [];
        for (const item of countByRoomTypeAndDate.values()) {
            if (item.bookedRooms > item.roomTypeCapacity) {
                errors.push({
                    code: 'CAPACITY_EXCEEDED',
                    hotelId,
                    roomTypeId: item.roomType.toString(),
                    date: formatDateYMD(item.date),
                    bookedRooms: item.bookedRooms,
                    capacity: item.roomTypeCapacity,
                    message: `Room type ${item.roomType} on ${formatDateYMD(item.date)} has ${item.bookedRooms} bookings exceeding capacity ${item.roomTypeCapacity}`
                });
            }
            inventoryDocs.push({
                hotel: item.hotel,
                roomType: item.roomType,
                date: item.date,
                bookedRooms: item.bookedRooms
            });
        }

        inventoryPlanByHotel.set(hotelId, inventoryDocs);
    }

    const summary = {
        totalBookingsInDb: rawBookings.length,
        hotelsAffected: plannedUpdatesByHotel.size,
        manifestEntries: entries.length,
        errorCount: errors.length
    };

    if (errors.length > 0) {
        return {
            success: false,
            mode,
            errors,
            summary
        };
    }

    if (mode === 'dry-run') {
        return {
            success: true,
            mode: 'dry-run',
            errors: [],
            summary
        };
    }

    // Apply mode: run one transaction per hotel in sorted hotelId order
    const sortedHotelIds = Array.from(plannedUpdatesByHotel.keys()).sort();

    for (const hotelId of sortedHotelIds) {
        const bookingPlans = plannedUpdatesByHotel.get(hotelId);
        const inventoryDocs = inventoryPlanByHotel.get(hotelId) || [];

        await withInventoryTransaction({ hotelIds: [hotelId] }, async (session) => {
            for (const plan of bookingPlans) {
                const bookingDoc = await Booking.findById(plan.bookingId).session(
                    session
                );
                if (!bookingDoc) {
                    throw createAppError(
                        `Booking ${plan.bookingId} disappeared during migration`,
                        404,
                        'BOOKING_NOT_FOUND'
                    );
                }

                bookingDoc.roomType = plan.roomTypeId;
                bookingDoc.nightlyPrices = plan.nightlyPrices;
                bookingDoc.totalPriceSatang = plan.totalPriceSatang;
                bookingDoc.pricingRuleVersion = plan.pricingRuleVersion;
                bookingDoc.schemaVersion = 2;

                await bookingDoc.save({ session });
            }

            // Reconcile inventory idempotently for this hotel
            await RoomInventory.deleteMany({ hotel: hotelId }).session(session);
            if (inventoryDocs.length > 0) {
                await RoomInventory.insertMany(inventoryDocs, { session });
            }
        });
    }

    // Post-migration verification
    const finalBookings = await Booking.find({}).lean();
    if (finalBookings.length !== rawBookings.length) {
        throw createAppError(
            `Booking count mismatch after migration: expected ${rawBookings.length}, got ${finalBookings.length}`,
            500,
            'MIGRATION_VERIFICATION_FAILED'
        );
    }

    for (const b of finalBookings) {
        const sum = (b.nightlyPrices || []).reduce(
            (acc, np) => acc + np.amountSatang,
            0
        );
        if (b.totalPriceSatang !== sum || b.schemaVersion !== 2) {
            throw createAppError(
                `Post-migration verification failed for booking ${b._id}`,
                500,
                'MIGRATION_VERIFICATION_FAILED'
            );
        }
    }

    return {
        success: true,
        mode: 'apply',
        errors: [],
        summary
    };
};

const runCli = async () => {
    const args = process.argv.slice(2);
    const manifestIndex = args.indexOf('--manifest');
    const isApply = args.includes('--apply');
    const mode = isApply ? 'apply' : 'dry-run';

    if (manifestIndex === -1 || !args[manifestIndex + 1]) {
        console.error(
            'Usage: node scripts/migrateBookings.js --manifest <path-to-manifest.json> [--dry-run | --apply]'
        );
        process.exit(1);
    }

    const manifestPath = path.resolve(process.cwd(), args[manifestIndex + 1]);
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);

    dotenv.config({ path: path.resolve(process.cwd(), 'config/config.env') });
    await mongoose.connect(process.env.MONGO_URI);

    try {
        const result = await migrateBookings({ manifest, mode });
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) {
            process.exitCode = 1;
        }
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    runCli().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    migrateBookings
};
