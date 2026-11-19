import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgres://ourhome@localhost:5433/ourhome_test';
process.env.SIGNUP_MODE = 'open';
process.env.TOKEN_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.STORAGE_DRIVER = 'fs';
process.env.STORAGE_DIR = path.join(os.tmpdir(), `ourhome-test-blobs-${process.pid}`);
process.env.AI_FEATURES = 'off';
