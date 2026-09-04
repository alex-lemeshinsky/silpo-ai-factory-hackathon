import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  TokenVaultError,
  createInMemoryTokenVaultStorage,
  createTokenVault,
  type TokenEnvelopeRow,
} from "./token-vault";

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);
const EXPIRES_AT = new Date("2026-09-04T12:00:00.000Z");
const BEFORE_EXPIRY = new Date("2026-09-04T11:00:00.000Z");
const AFTER_EXPIRY = new Date("2026-09-04T13:00:00.000Z");

type Fake = ReturnType<typeof createInMemoryTokenVaultStorage>;

function setup(overrides: { key?: Buffer; now?: () => Date } = {}) {
  const storage = createInMemoryTokenVaultStorage();
  const vault = createTokenVault({
    storage,
    encryptionKey: overrides.key ?? KEY_A,
    now: overrides.now ?? (() => BEFORE_EXPIRY),
  });
  return { storage, vault };
}

function envelopeOf(storage: Fake, userId: string): TokenEnvelopeRow {
  const row = storage.raw(userId).find((candidate) => candidate.tokenCiphertext !== null);
  if (!row || row.tokenCiphertext === null || row.tokenIv === null || row.tokenAuthTag === null) {
    throw new Error("expected an envelope row");
  }
  return {
    tokenCiphertext: row.tokenCiphertext,
    tokenIv: row.tokenIv,
    tokenAuthTag: row.tokenAuthTag,
    expiresAt: row.expiresAt,
    scope: row.scope,
    oauthMetadata: row.oauthMetadata,
  };
}

describe("TokenVault", () => {
  it("returns the tokens it stored", async () => {
    const { vault } = setup();

    await vault.put("u1", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: EXPIRES_AT,
      scope: "cart:write",
    });

    expect(await vault.get("u1")).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      scope: "cart:write",
      isExpired: false,
    });
  });

  it("does not store access or refresh tokens as plaintext", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: EXPIRES_AT,
    });

    const atRest = JSON.stringify(storage.raw("u1"));
    const ciphertextBytes = Buffer.from(envelopeOf(storage, "u1").tokenCiphertext, "base64");

    for (const token of ["access-secret", "refresh-secret"]) {
      expect(atRest).not.toContain(token);
      // latin1 preserves bytes one to one, so a merely encoded token surfaces here.
      expect(ciphertextBytes.toString("latin1")).not.toContain(token);
    }

    expect(await vault.get("u1")).toMatchObject({ accessToken: "access-secret" });
  });

  it("keeps the client secret inside the envelope", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", {
      accessToken: "access-value",
      clientSecret: "client-secret-value",
    });

    const ciphertextBytes = Buffer.from(envelopeOf(storage, "u1").tokenCiphertext, "base64");

    expect(JSON.stringify(storage.raw("u1"))).not.toContain("client-secret-value");
    expect(ciphertextBytes.toString("latin1")).not.toContain("client-secret-value");
    expect(await vault.get("u1")).toMatchObject({ clientSecret: "client-secret-value" });
  });

  it("uses a fresh initialization vector for every write", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", { accessToken: "access-value" });
    const first = envelopeOf(storage, "u1");
    await vault.put("u1", { accessToken: "access-value" });
    const second = envelopeOf(storage, "u1");

    expect(second.tokenIv).not.toBe(first.tokenIv);
    expect(second.tokenCiphertext).not.toBe(first.tokenCiphertext);
  });

  it("rejects an envelope encrypted under another key", async () => {
    const storage = createInMemoryTokenVaultStorage();
    const writer = createTokenVault({ storage, encryptionKey: KEY_A, now: () => BEFORE_EXPIRY });
    const reader = createTokenVault({ storage, encryptionKey: KEY_B, now: () => BEFORE_EXPIRY });

    await writer.put("u1", { accessToken: "access-value" });

    await expect(reader.get("u1")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("rejects a tampered envelope", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await storage.write("u1", {
      ...envelopeOf(storage, "u1"),
      tokenAuthTag: Buffer.alloc(16, 9).toString("base64"),
    });

    await expect(vault.get("u1")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("rejects an envelope transplanted to another user", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await storage.write("u2", envelopeOf(storage, "u1"));

    await expect(vault.get("u2")).rejects.toBeInstanceOf(TokenVaultError);
  });

  it("reports a typed error without leaking secrets", async () => {
    const storage = createInMemoryTokenVaultStorage();
    const writer = createTokenVault({ storage, encryptionKey: KEY_A, now: () => BEFORE_EXPIRY });
    const reader = createTokenVault({ storage, encryptionKey: KEY_B, now: () => BEFORE_EXPIRY });
    await writer.put("u1", { accessToken: "access-secret" });

    const caught: unknown = await reader.get("u1").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TokenVaultError);
    expect((caught as TokenVaultError).code).toBe("envelope_unreadable");
    expect((caught as TokenVaultError).message).not.toContain("secret");
  });

  it("rejects an envelope written in an unsupported format version", async () => {
    const { storage, vault } = setup();
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv("aes-256-gcm", KEY_A, iv);
    cipher.setAAD(Buffer.from("u1", "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(
        JSON.stringify({
          version: 2,
          accessToken: "access-value",
          refreshToken: null,
          clientSecret: null,
        }),
        "utf8",
      ),
      cipher.final(),
    ]);

    await storage.write("u1", {
      tokenCiphertext: ciphertext.toString("base64"),
      tokenIv: iv.toString("base64"),
      tokenAuthTag: cipher.getAuthTag().toString("base64"),
      expiresAt: null,
      scope: null,
      oauthMetadata: null,
    });

    const caught: unknown = await vault.get("u1").catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(TokenVaultError);
    expect((caught as TokenVaultError).code).toBe("unsupported_envelope_version");
  });

  it("replaces the previous envelope for the same user", async () => {
    const { storage, vault } = setup();

    await vault.put("u1", { accessToken: "first-value" });
    await vault.put("u1", { accessToken: "second-value" });

    expect(storage.raw("u1")).toHaveLength(1);
    expect(await vault.get("u1")).toMatchObject({ accessToken: "second-value" });
  });

  it("ignores legacy ciphertext rows", async () => {
    const { storage, vault } = setup();

    storage.seedLegacyRow("u1", "legacy-blob");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toHaveLength(1);
  });

  it("returns expired credentials with an expiry flag", async () => {
    const { vault } = setup({ now: () => AFTER_EXPIRY });

    await vault.put("u1", {
      accessToken: "access-value",
      refreshToken: "refresh-value",
      expiresAt: EXPIRES_AT,
    });

    expect(await vault.get("u1")).toMatchObject({
      isExpired: true,
      refreshToken: "refresh-value",
    });
  });

  it("treats an unknown expiry as unexpired", async () => {
    const { vault } = setup({ now: () => AFTER_EXPIRY });

    await vault.put("u1", { accessToken: "access-value" });

    expect(await vault.get("u1")).toMatchObject({ expiresAt: null, isExpired: false });
  });

  it("clears an envelope and tolerates repeat clears", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toHaveLength(0);
    await expect(vault.clear("u1")).resolves.toBeUndefined();

    await vault.put("u1", { accessToken: "second-value" });
    expect(await vault.get("u1")).toMatchObject({ accessToken: "second-value" });
  });

  it("keeps legacy ciphertext when clearing", async () => {
    const { storage, vault } = setup();
    storage.seedLegacyRow("u1", "legacy-blob");
    await vault.put("u1", { accessToken: "access-value" });

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toEqual([
      expect.objectContaining({ legacyEncryptedTokens: "legacy-blob", tokenCiphertext: null }),
    ]);
  });

  it("keeps legacy ciphertext on a row that also holds an envelope", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value" });
    storage.attachLegacyCiphertext("u1", "legacy-blob");

    await vault.clear("u1");

    expect(await vault.get("u1")).toBeNull();
    expect(storage.raw("u1")).toEqual([
      expect.objectContaining({
        legacyEncryptedTokens: "legacy-blob",
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
      }),
    ]);
  });

  it("refuses secret-shaped keys in oauth metadata", async () => {
    const { vault } = setup();

    await expect(
      vault.put("u1", {
        accessToken: "access-value",
        oauthMetadata: { clientId: "abc", client_secret: "leak" },
      }),
    ).rejects.toThrow();

    await expect(
      vault.put("u1", {
        accessToken: "access-value",
        oauthMetadata: { clientId: "abc", issuer: "https://auth.silpo.ua" },
      }),
    ).resolves.toBeUndefined();
  });

  it("reads back an envelope written under a differently cased user id", async () => {
    const { vault } = setup();
    const upper = "A1B2C3D4-0000-4000-8000-000000000001";

    await vault.put(upper, { accessToken: "access-value" });

    expect(await vault.get(upper.toLowerCase())).toMatchObject({ accessToken: "access-value" });
  });

  it("survives malformed values in the plaintext columns", async () => {
    const { storage, vault } = setup();
    await vault.put("u1", { accessToken: "access-value", scope: "cart:write" });

    await storage.write("u1", {
      ...envelopeOf(storage, "u1"),
      scope: 42 as unknown as string,
      oauthMetadata: ["not-an-object"] as unknown as Record<string, unknown>,
    });

    expect(await vault.get("u1")).toMatchObject({
      accessToken: "access-value",
      scope: null,
      oauthMetadata: null,
    });
  });

  it("validates its inputs before writing", async () => {
    const { storage, vault } = setup();

    await expect(vault.put("", { accessToken: "access-value" })).rejects.toThrow();
    await expect(vault.put("u1", { accessToken: "   " })).rejects.toThrow();
    await expect(vault.get("")).rejects.toThrow();

    expect(storage.raw("u1")).toHaveLength(0);
  });
});

