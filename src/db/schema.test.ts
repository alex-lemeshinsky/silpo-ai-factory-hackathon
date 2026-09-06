import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { draftItems, mcpConnections } from "./schema";

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
