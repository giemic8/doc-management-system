import { initialSchema } from './v001_initial_schema';
import { canonicalIngestion } from './v002_canonical_ingestion';
import { dualCopyDurability } from './v003_dual_copy_durability';
import { trashAndPurge } from './v004_trash_and_purge';
import { familySpaces } from './v005_family_spaces';
import { reviewInbox } from './v006_review_inbox';
import { opsAlerts } from './v007_ops_alerts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  initialSchema,
  canonicalIngestion,
  dualCopyDurability,
  trashAndPurge,
  familySpaces,
  reviewInbox,
  opsAlerts,
];
