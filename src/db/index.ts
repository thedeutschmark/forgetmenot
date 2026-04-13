import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error("Database not initialized. Call initDb() first.");
  return db;
}

export function initDb(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "forgetmenot.sqlite");

  db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Run migrations
  const currentVersion = getSchemaVersion();
  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    setSchemaVersion(i + 1);
  }

  console.log(`[db] SQLite ready at ${dbPath} (schema v${getSchemaVersion()})`);
  return db;
}

function getSchemaVersion(): number {
  if (!db) return 0;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(version: number): void {
  if (!db) return;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
