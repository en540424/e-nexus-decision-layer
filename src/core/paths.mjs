import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** repo ルート（src/core/ の2つ上） */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
