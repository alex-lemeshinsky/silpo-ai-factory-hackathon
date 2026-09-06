import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openBytes, sealBytes, type SealedBytes } from "./envelope";

describe("envelope", () => {
  it("binds a secret to its purpose and user with a fresh IV", () => {
    const key = randomBytes(32);
    const aad = "silpo-oauth-state:v1:user-1";
    const value = Buffer.from("synthetic-verifier");
    const first = sealBytes(key, aad, value);
    const second = sealBytes(key, aad, value);
    expect(first.iv).not.toBe(second.iv);
    expect(Buffer.from(first.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(first.authTag, "base64")).toHaveLength(16);
    expect(openBytes(key, aad, first)).toEqual(value);
    expect(() => openBytes(key, "user-1", first)).toThrow();
    expect(() => openBytes(key, "silpo-oauth-state:v1:user-2", first)).toThrow();
    expect(Buffer.from(first.ciphertext, "base64").includes(value)).toBe(false);
  });

  it("rejects keys that are not 32 bytes in sealBytes and openBytes", () => {
    const validKey = randomBytes(32);
    const invalidShortKey = randomBytes(16);
    const invalidLongKey = randomBytes(64);
    const aad = "purpose:user-1";
    const value = Buffer.from("secret");
    const envelope = sealBytes(validKey, aad, value);

    expect(() => sealBytes(invalidShortKey, aad, value)).toThrow("invalid_key_length");
    expect(() => sealBytes(invalidLongKey, aad, value)).toThrow("invalid_key_length");
    expect(() => openBytes(invalidShortKey, aad, envelope)).toThrow("invalid_key_length");
    expect(() => openBytes(invalidLongKey, aad, envelope)).toThrow("invalid_key_length");
  });

  it("rejects decryption with a different key", () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(keyA, aad, Buffer.from("secret"));

    expect(() => openBytes(keyB, aad, envelope)).toThrow("decryption_failed");
  });

  it("rejects an envelope with a bad IV length", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(key, aad, Buffer.from("secret"));

    const badIv16 = { ...envelope, iv: randomBytes(16).toString("base64") };
    expect(() => openBytes(key, aad, badIv16)).toThrow("invalid_envelope");

    const badIv8 = { ...envelope, iv: randomBytes(8).toString("base64") };
    expect(() => openBytes(key, aad, badIv8)).toThrow("invalid_envelope");
  });

  it("rejects an envelope with a bad auth tag length", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(key, aad, Buffer.from("secret"));

    const badTag12 = { ...envelope, authTag: randomBytes(12).toString("base64") };
    expect(() => openBytes(key, aad, badTag12)).toThrow("invalid_envelope");

    const badTag32 = { ...envelope, authTag: randomBytes(32).toString("base64") };
    expect(() => openBytes(key, aad, badTag32)).toThrow("invalid_envelope");
  });

  it("rejects a tampered auth tag", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(key, aad, Buffer.from("secret"));

    const tagBytes = Buffer.from(envelope.authTag, "base64");
    tagBytes[0] ^= 0xff;
    const tampered = { ...envelope, authTag: tagBytes.toString("base64") };

    expect(() => openBytes(key, aad, tampered)).toThrow("decryption_failed");
  });

  it("rejects tampered ciphertext bytes", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(key, aad, Buffer.from("secret"));

    const cipherBytes = Buffer.from(envelope.ciphertext, "base64");
    cipherBytes[0] ^= 0xff;
    const tampered = { ...envelope, ciphertext: cipherBytes.toString("base64") };

    expect(() => openBytes(key, aad, tampered)).toThrow("decryption_failed");
  });

  it("rejects malformed or non-canonical base64", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";
    const envelope = sealBytes(key, aad, Buffer.from("secret"));

    expect(() => openBytes(key, aad, { ...envelope, iv: envelope.iv + "=" })).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ...envelope, authTag: envelope.authTag + "==" })).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ...envelope, ciphertext: envelope.ciphertext + "%" })).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ...envelope, ciphertext: "" })).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ...envelope, iv: "" })).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ...envelope, authTag: "" })).toThrow("invalid_envelope");
  });

  it("rejects malformed envelope objects", () => {
    const key = randomBytes(32);
    const aad = "purpose:user-1";

    expect(() => openBytes(key, aad, null as unknown as SealedBytes)).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, undefined as unknown as SealedBytes)).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, {} as unknown as SealedBytes)).toThrow("invalid_envelope");
    expect(() => openBytes(key, aad, { ciphertext: 123 } as unknown as SealedBytes)).toThrow("invalid_envelope");
  });
});
