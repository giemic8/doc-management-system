import { initialSchema } from './v001_initial_schema';
import { canonicalIngestion } from './v002_canonical_ingestion';
import { dualCopyDurability } from './v003_dual_copy_durability';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [initialSchema, canonicalIngestion, dualCopyDurability];
