import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface SealedBytes {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function decodeBase64(value: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("invalid_envelope");
  }
  const decoded = Buffer.from(value, "base64");
  const canonicalPadded = decoded.toString("base64");
  const canonicalUnpadded = canonicalPadded.replace(/=+$/, "");
  const canonical = value === canonicalPadded || value === canonicalUnpadded;
  if (decoded.byteLength === 0 || !canonical) {
    throw new Error("invalid_envelope");
  }
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new Error("invalid_envelope");
  }
  return decoded;
}

export function sealBytes(key: Buffer, aad: string, plaintext: Buffer): SealedBytes {
  if (!Buffer.isBuffer(key) || key.byteLength !== KEY_BYTES) {
    throw new Error("invalid_key_length");
  }
  if (typeof aad !== "string") {
    throw new Error("invalid_aad");
  }
  if (!Buffer.isBuffer(plaintext)) {
    throw new Error("invalid_plaintext");
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function openBytes(key: Buffer, aad: string, envelope: SealedBytes): Buffer {
  if (!Buffer.isBuffer(key) || key.byteLength !== KEY_BYTES) {
    throw new Error("invalid_key_length");
  }
  if (typeof aad !== "string") {
    throw new Error("invalid_aad");
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.authTag !== "string"
  ) {
    throw new Error("invalid_envelope");
  }

  const iv = decodeBase64(envelope.iv, IV_BYTES);
  const authTag = decodeBase64(envelope.authTag, AUTH_TAG_BYTES);
  const ciphertext = decodeBase64(envelope.ciphertext);

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("decryption_failed");
  }
}
