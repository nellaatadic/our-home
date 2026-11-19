import { migrate } from './migrate.js';
import { closePool } from './db.js';

migrate(undefined, (m) => console.log(m))
  .then((n) => console.log(`migrations up to date (${n} files)`))
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
