import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { authSessions, draftItems, mcpConnections, silpoOAuthStates } from "./schema";

describe("mcpConnections schema", () => {
  it("stores AES-GCM ciphertext, IV, and authentication tag separately", () => {
    const columns = getTableColumns(mcpConnections);

    expect(columns).toHaveProperty("tokenCiphertext");
    expect(columns).toHaveProperty("tokenIv");
    expect(columns).toHaveProperty("tokenAuthTag");
    expect(columns.legacyEncryptedTokens.name).toBe("encrypted_tokens");
    expect(columns.tokenCiphertext.notNull).toBe(false);
    expect(columns.tokenIv.notNull).toBe(false);
    expect(columns.tokenAuthTag.notNull).toBe(false);
  });
});

describe("draftItems schema", () => {
  it("A7-02 stores product presentation fields", () => {
    const columns = getTableColumns(draftItems);

    expect(columns.imageUrl.name).toBe("image_url");
    expect(columns.displayRatio.name).toBe("display_ratio");
    expect(columns.specialPrice.name).toBe("special_price");
    expect(columns.promotions.name).toBe("promotions");
  });
});

describe("authSessions schema", () => {
  it("defines the expected columns and non-null constraints", () => {
    const columns = getTableColumns(authSessions);

    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("userId");
    expect(columns).toHaveProperty("handleHash");
    expect(columns).toHaveProperty("status");
    expect(columns).toHaveProperty("expiresAt");
    expect(columns).toHaveProperty("createdAt");

    expect(columns.id.notNull).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.handleHash.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.createdAt.notNull).toBe(true);
  });
});

describe("silpoOAuthStates schema", () => {
  it("defines the expected columns, non-null encrypted fields, and default version", () => {
    const columns = getTableColumns(silpoOAuthStates);

    expect(columns).toHaveProperty("id");
    expect(columns).toHaveProperty("userId");
    expect(columns).toHaveProperty("version");
    expect(columns).toHaveProperty("phase");
    expect(columns).toHaveProperty("bindingHash");
    expect(columns).toHaveProperty("flowExpiresAt");
    expect(columns).toHaveProperty("ciphertext");
    expect(columns).toHaveProperty("iv");
    expect(columns).toHaveProperty("authTag");
    expect(columns).toHaveProperty("updatedAt");

    expect(columns.id.notNull).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.version.notNull).toBe(true);
    expect(columns.phase.notNull).toBe(true);
    expect(columns.bindingHash.notNull).toBe(false);
    expect(columns.flowExpiresAt.notNull).toBe(false);
    expect(columns.ciphertext.notNull).toBe(true);
    expect(columns.iv.notNull).toBe(true);
    expect(columns.authTag.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });
});
