use rusqlite::{Connection, params};
use parking_lot::Mutex;
use std::path::PathBuf;

pub struct DataDb {
    conn: Mutex<Connection>,
}

impl DataDb {
    pub fn open(db_path: &PathBuf) -> Result<Self, String> {
        match Self::try_open(db_path) {
            Ok(db) => Ok(db),
            Err(first_err) => {
                // The database may have been left corrupt/empty by a crash mid-migration.
                // Remove it (and any WAL/journal sidecars) and recreate from scratch.
                let _ = std::fs::remove_file(db_path);
                let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
                let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
                Self::try_open(db_path).map_err(|e| format!("{}; recovery failed: {}", first_err, e))
            }
        }
    }

    fn try_open(db_path: &PathBuf) -> Result<Self, String> {
        let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        // Avoid WAL mode: on some Windows setups it is flaky (AV locking -wal/-shm
        // files). All access is serialised behind a mutex, so the default journal
        // mode is fine and more reliable here.
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS media (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                path TEXT NOT NULL,
                media_type TEXT NOT NULL,
                fit_mode TEXT DEFAULT 'contain',
                description TEXT DEFAULT '',
                tags TEXT DEFAULT '[]',
                category TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS songs (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS presentations (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS scenes (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS services (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ").map_err(|e| e.to_string())
    }

    // ---- Key-Value operations ----

    pub fn kv_get(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM kv_store WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        let result = stmt.query_row(params![key], |row| row.get::<_, String>(0));
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO kv_store (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- Media operations ----

    pub fn list_media(&self) -> Result<Vec<(String, String, String, String, String, String, String, String)>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, filename, path, media_type, fit_mode, description, tags, category FROM media ORDER BY filename COLLATE NOCASE"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        }).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|e| e.to_string())?);
        }
        Ok(items)
    }

    pub fn media_exists(&self, path: &str) -> Result<bool, String> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM media WHERE path = ?1", params![path], |row| row.get(0)
        ).map_err(|e| e.to_string())?;
        Ok(count > 0)
    }

    pub fn insert_media(&self, id: &str, filename: &str, path: &str, media_type: &str, created_at: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO media (id, filename, path, media_type, fit_mode, description, tags, category, created_at) VALUES (?1,?2,?3,?4,'contain','','[]','',?5)",
            params![id, filename, path, media_type, created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_media(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM media WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_media_bulk(&self, ids: &[String]) -> Result<(), String> {
        let conn = self.conn.lock();
        for id in ids {
            conn.execute("DELETE FROM media WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_media_path(&self, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path FROM media WHERE id = ?1").map_err(|e| e.to_string())?;
        match stmt.query_row(params![id], |row| row.get::<_, String>(0)) {
            Ok(p) => Ok(Some(p)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set_media_fit(&self, id: &str, fit_mode: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("UPDATE media SET fit_mode = ?1 WHERE id = ?2", params![fit_mode, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_media_metadata(&self, id: &str, description: &Option<String>, tags: &str, category: &Option<String>) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE media SET description = ?1, tags = ?2, category = ?3 WHERE id = ?4",
            params![description.as_deref().unwrap_or(""), tags, category.as_deref().unwrap_or(""), id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_media_tags(&self, id: &str) -> Result<String, String> {
        let conn = self.conn.lock();
        conn.query_row("SELECT tags FROM media WHERE id = ?1", params![id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())
    }

    // ---- Hash-backed operations (songs, presentations, scenes, services) ----

    pub fn hash_list(&self, table: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.conn.lock();
        let sql = format!("SELECT id, data FROM {} ORDER BY id", table);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for row in rows { items.push(row.map_err(|e| e.to_string())?); }
        Ok(items)
    }

    pub fn hash_get(&self, table: &str, id: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        let sql = format!("SELECT data FROM {} WHERE id = ?1", table);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        match stmt.query_row(params![id], |row| row.get::<_, String>(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn hash_set(&self, table: &str, id: &str, data: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        let sql = format!("INSERT INTO {} (id, data) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data", table);
        conn.execute(&sql, params![id, data]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn hash_delete(&self, table: &str, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        let sql = format!("DELETE FROM {} WHERE id = ?1", table);
        conn.execute(&sql, params![id]).map_err(|e| e.to_string())?;
        Ok(())
    }
}
