import 'dotenv/config';
import { administratorKey } from '../src/lib/credentials.js';
import { closeDb } from '../src/lib/db/index.js';

console.log('Administrator key. Use it only to unlock Settings, never give it to an integration.\n');
console.log(administratorKey());
closeDb();
