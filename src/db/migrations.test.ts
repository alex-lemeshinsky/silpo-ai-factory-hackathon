// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DRIZZLE_DIR = join(process.cwd(), "drizzle");

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}

describe("drizzle migrations", () => {
  it("A17-65 registers every SQL file in the journal the migrator reads", () => {
    const journal = JSON.parse(
      readFileSync(join(DRIZZLE_DIR, "meta", "_journal.json"), "utf8"),
    ) as Journal;
    const files = readdirSync(DRIZZLE_DIR)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => file.replace(/\.sql$/, ""))
      .sort();
    const tags = journal.entries.map((entry) => entry.tag);

    // The migrator applies journal entries only. A file missing from it is
    // never run, and every query that names its columns then fails. The
    // Postgres gates apply files by directory listing, so they cannot see it.
    expect(tags).toEqual(files);
    expect(journal.entries.map((entry) => entry.idx)).toEqual(tags.map((_, index) => index));

    // Without the snapshot, the next `db:generate` diffs against an older one
    // and emits these columns a second time.
    for (const tag of tags) {
      const snapshot = join(DRIZZLE_DIR, "meta", `${tag.slice(0, 4)}_snapshot.json`);
      expect(existsSync(snapshot), `${tag} has no snapshot`).toBe(true);
    }
  });
});
