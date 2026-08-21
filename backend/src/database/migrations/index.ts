import { initialSchema } from './v001_initial_schema';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [initialSchema];
