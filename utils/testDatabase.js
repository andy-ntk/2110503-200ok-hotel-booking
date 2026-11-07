// Integration tests delete their fixtures and drop this database on completion.
const assertTestDatabase = (uri) => {
    if (!uri) {
        throw new Error('TEST_MONGO_URI is required for integration tests');
    }
    const database = new URL(uri).pathname.slice(1);
    if (!/(?:-|_)test$/.test(database)) {
        throw new Error('TEST_MONGO_URI database name must end in -test or _test');
    }
};

module.exports = { assertTestDatabase };
