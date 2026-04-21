// lib/ko/outputEncryption.ts
// KarlOps L — Output encryption/decryption utility
// AES-256-GCM: compress → encrypt → base64 for storage
// base64 → decrypt → decompress for reading

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync   = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const ALGORITHM   = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.KO_OUTPUT_KEY;
  if (!key || key.length !== 64) throw new Error('KO_OUTPUT_KEY must be a 64-char hex string (32 bytes)');
  return Buffer.from(key, 'hex');
}

export async function encryptOutput(plaintext: string): Promise<string> {
  const key        = getEncryptionKey();
  const iv         = randomBytes(12); // 96-bit IV for GCM
  const compressed = await gzipAsync(Buffer.from(plaintext, 'utf-8'));
  const cipher     = createCipheriv(ALGORITHM, key, iv);
  const encrypted  = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  // Format: iv(12) + authTag(16) + ciphertext — base64 encoded
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export async function decryptOutput(stored: string): Promise<string> {
  const key          = getEncryptionKey();
  const buf          = Buffer.from(stored, 'base64');
  const iv           = buf.subarray(0, 12);
  const authTag      = buf.subarray(12, 28);
  const encrypted    = buf.subarray(28);
  const decipher     = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const compressed   = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const decompressed = await gunzipAsync(compressed);
  return decompressed.toString('utf-8');
}