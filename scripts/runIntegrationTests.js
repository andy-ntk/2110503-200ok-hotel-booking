const { spawnSync } = require('node:child_process');
const { assertTestDatabase } = require('../utils/testDatabase');

try {
    assertTestDatabase(process.env.TEST_MONGO_URI);
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1'], {
        stdio: 'inherit',
        env: { ...process.env, NODE_ENV: 'test' }
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} catch (err) {
    console.error(err.message);
    process.exitCode = 1;
}
