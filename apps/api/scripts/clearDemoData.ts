import 'dotenv/config';
import { closeDb } from '../src/lib/db/index.js';
import { clearDemoRequests } from '../src/lib/db/requests.js';

try {
  console.log(`Removed ${clearDemoRequests()} seeded requests. Live and offline requests were preserved.`);
} finally {
  closeDb();
}
