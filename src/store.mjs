import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";

export class AppStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_user (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_state (
        state TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  bootstrap({ settings, adminUsername, adminPassword }) {
    const now = new Date().toISOString();

    const existingConfig = this.db.prepare("SELECT data FROM app_config WHERE id = 1").get();
    if (!existingConfig) {
      this.db.prepare(`
        INSERT INTO app_config (id, data, updated_at)
        VALUES (1, ?, ?)
      `).run(JSON.stringify(settings), now);
    }

    const existingAdmin = this.db.prepare("SELECT username FROM admin_user WHERE id = 1").get();
    if (!existingAdmin) {
      const passwordHash = bcrypt.hashSync(adminPassword, 12);
      this.db.prepare(`
        INSERT INTO admin_user (id, username, password_hash, updated_at)
        VALUES (1, ?, ?, ?)
      `).run(adminUsername, passwordHash, now);
    }

    this.cleanupOAuthState();
  }

  getSettings() {
    const row = this.db.prepare("SELECT data FROM app_config WHERE id = 1").get();
    if (!row) {
      throw new Error("App settings are not initialized");
    }
    return JSON.parse(row.data);
  }

  saveSettings(settings) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE app_config
      SET data = ?, updated_at = ?
      WHERE id = 1
    `).run(JSON.stringify(settings), now);
    return settings;
  }

  getAdminUser() {
    return this.db.prepare(`
      SELECT username, updated_at
      FROM admin_user
      WHERE id = 1
    `).get();
  }

  verifyAdmin(username, password) {
    const row = this.db.prepare(`
      SELECT username, password_hash
      FROM admin_user
      WHERE id = 1
    `).get();

    if (!row) {
      return false;
    }
    if (row.username !== username) {
      return false;
    }
    return bcrypt.compareSync(password, row.password_hash);
  }

  updateAdminCredentials(username, password) {
    const now = new Date().toISOString();
    const passwordHash = bcrypt.hashSync(password, 12);
    this.db.prepare(`
      UPDATE admin_user
      SET username = ?, password_hash = ?, updated_at = ?
      WHERE id = 1
    `).run(username, passwordHash, now);
  }

  createOAuthState(provider, origin) {
    const state = crypto.randomBytes(24).toString("hex");
    this.db.prepare(`
      INSERT INTO oauth_state (state, provider, origin, created_at)
      VALUES (?, ?, ?, ?)
    `).run(state, provider, origin, new Date().toISOString());
    return state;
  }

  consumeOAuthState(state) {
    const row = this.db.prepare(`
      SELECT state, provider, origin, created_at
      FROM oauth_state
      WHERE state = ?
    `).get(state);

    if (!row) {
      return null;
    }

    this.db.prepare("DELETE FROM oauth_state WHERE state = ?").run(state);
    return row;
  }

  cleanupOAuthState() {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    this.db.prepare("DELETE FROM oauth_state WHERE created_at < ?").run(cutoff);
  }
}
