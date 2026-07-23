import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  env: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'super_secret_jwt_key_change_in_prod',
  mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY || 'change_this_mfa_encryption_key_in_prod',
  databaseUrl: process.env.DATABASE_URL || 'postgres://dms_user:dms_secret_password@localhost:5432/dms_db',
  redisHost: process.env.REDIS_HOST || 'localhost',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  storagePath: process.env.STORAGE_PATH || path.join(__dirname, '../../../storage'),
};
