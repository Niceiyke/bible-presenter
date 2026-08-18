use rusqlite::{Connection, params};
use parking_lot::Mutex;
use std::path::PathBuf;

pub struct DataDb {
    conn: Mutex<Connection>,
}

/// Why opening the data database failed. Only an explicitly corrupt file is
/// quarantined and recreated; permission, transient-lock, IO, or migration
/// errors must surface so a valid installation is never hidden behind an empty
/// workspace (audit: quarantine only on corruption evidence).
#[derive(Debug)]
pub enum OpenError {
    /// Demonstrable corruption (SQLITE_CORRUPT / SQLITE_NOTADB). Safe to
    /// quarantine and recreate.
    Corrupt(String),
    /// Everything else (permission, lock, IO, migration bug). The existing
    /// database must NOT be touched.
    Other(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Corrupt(e) => write!(f, "corrupt database: {e}"),
            OpenError::Other(e) => write!(f, "{e}"),
        }
    }
}

/// Classifies a rusqlite error as demonstrable corruption vs everything else.
///
/// The SQLite primary code is authoritative: a specific non-corrupt code
/// (CANTOPEN, BUSY, LOCKED, READONLY, PERM, IOERR, ...) is never treated as
/// corruption — even if a path in the message happens to contain the word
/// "corrupt". The free-text message heuristic only applies to the generic
/// `Error`(1)/`Unknown` codes, where SQLite has no finer-grained code.
fn is_corruption(err: &rusqlite::Error) -> bool {
    if let Some(ferr) = err.sqlite_error() {
        use rusqlite::ffi::ErrorCode as C;
        if matches!(ferr.code, C::DatabaseCorrupt | C::NotADatabase) {
            return true;
        }
        if !matches!(ferr.code, C::Unknown) {
            // A specific, non-corrupt result code — never corruption.
            return false;
        }
    }
    if let rusqlite::Error::SqliteFailure(_, Some(m)) = err {
        let m = m.to_ascii_lowercase();
        return m.contains("not a database")
            || m.contains("malformed")
            || m.contains("database disk image")
            || m.contains("database schema is not");
    }
    false
}

fn classify_open_err(e: rusqlite::Error) -> OpenError {
    if is_corruption(&e) {
        OpenError::Corrupt(e.to_string())
    } else {
        OpenError::Other(e.to_string())
    }
}

/// Row shape for `list_media`: (id, filename, path, media_type, fit_mode,
/// description, tags, category, thumbnail_path, duration, width, height,
/// content_hash, loop_playback, playback_rate, volume).
pub type MediaRow = (
    String, String, String, String, String, String, String, String,
    String, Option<f64>, Option<i64>, Option<i64>, String, bool, f64, f64,
);

impl DataDb {
    pub fn open(db_path: &PathBuf) -> Result<Self, OpenError> {
        match Self::try_open(db_path) {
            Ok(db) => Ok(db),
            // Permission, transient lock, IO, or migration error: NEVER
            // quarantine or replace the database — a valid installation must
            // not be made to look empty. Surface the error to the caller.
            Err(e @ OpenError::Other(_)) => Err(e),
            Err(OpenError::Corrupt(first_err)) => {
                // The database is demonstrably corrupt (crash mid-migration,
                // disk fault). NEVER delete user data blindly — quarantine the
                // damaged file (and any WAL/SHM sidecars) by renaming it aside
                // so it can be inspected later, then recreate fresh (audit #4).
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = std::fs::rename(db_path, db_path.with_extension(format!("corrupt-{}", stamp)));
                let _ = std::fs::rename(
                    db_path.with_extension("db-wal"),
                    db_path.with_extension(format!("corrupt-{}.db-wal", stamp)),
                );
                let _ = std::fs::rename(
                    db_path.with_extension("db-shm"),
                    db_path.with_extension(format!("corrupt-{}.db-shm", stamp)),
                );
                Self::try_open(db_path).map_err(|e| match e {
                    OpenError::Other(msg) => OpenError::Other(format!("{}; recovery failed: {}", first_err, msg)),
                    OpenError::Corrupt(msg) => OpenError::Corrupt(format!("{}; recovery failed: {}", first_err, msg)),
                })
            }
        }
    }

    fn try_open(db_path: &PathBuf) -> Result<Self, OpenError> {
        let conn = Connection::open(db_path).map_err(classify_open_err)?;
        // Avoid WAL mode: on some Windows setups it is flaky (AV locking -wal/-shm
        // files). All access is serialised behind a mutex, so the default journal
        // mode is fine and more reliable here.
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(classify_open_err)?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate().map_err(classify_open_err)?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate().map_err(|e| e.to_string())?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), rusqlite::Error> {
        let conn = self.conn.lock();
        let current_version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        // Every step is idempotent (`CREATE TABLE IF NOT EXISTS` / additive
        // columns), so running an older DB through all steps is safe. The
        // `user_version` pragma records the schema for future versioned
        // migrations (audit: forward migrations must be versioned, and the
        // slide_templates table the studio editor writes to must exist).
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
                created_at TEXT NOT NULL,
                thumbnail_path TEXT DEFAULT '',
                duration REAL,
                width INTEGER,
                height INTEGER,
                content_hash TEXT DEFAULT '',
                loop_playback INTEGER DEFAULT 0,
                playback_rate REAL DEFAULT 1.0,
                volume REAL DEFAULT 1.0
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
            CREATE TABLE IF NOT EXISTS slide_templates (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        ")?;

        // Forward-migrate older DBs that predate the P4.8 media columns.
        // `PRAGMA table_info` is the portable existence check (there is no
        // `ADD COLUMN IF NOT EXISTS` in SQLite).
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(media)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut v = Vec::new();
            for r in rows { v.push(r?); }
            v
        };
        for (col, ddl) in [
            ("thumbnail_path", "ALTER TABLE media ADD COLUMN thumbnail_path TEXT DEFAULT ''"),
            ("duration", "ALTER TABLE media ADD COLUMN duration REAL"),
            ("width", "ALTER TABLE media ADD COLUMN width INTEGER"),
            ("height", "ALTER TABLE media ADD COLUMN height INTEGER"),
            ("content_hash", "ALTER TABLE media ADD COLUMN content_hash TEXT DEFAULT ''"),
            ("loop_playback", "ALTER TABLE media ADD COLUMN loop_playback INTEGER DEFAULT 0"),
            ("playback_rate", "ALTER TABLE media ADD COLUMN playback_rate REAL DEFAULT 1.0"),
            ("volume", "ALTER TABLE media ADD COLUMN volume REAL DEFAULT 1.0"),
        ] {
            if !cols.iter().any(|c| c == col) {
                conn.execute_batch(ddl)?;
            }
        }

        // Record the schema version (currently 1). Future migrations gate on
        // `current_version` and bump it here.
        if current_version < 1 {
            conn.execute_batch("PRAGMA user_version = 1;")?;
        }
        Ok(())
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

    pub fn list_media(&self) -> Result<Vec<MediaRow>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, filename, path, media_type, fit_mode, description, tags, category,
                    thumbnail_path, duration, width, height, content_hash,
                    loop_playback, playback_rate, volume
             FROM media ORDER BY filename COLLATE NOCASE"
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
                row.get::<_, String>(8)?,
                row.get::<_, Option<f64>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, String>(12)?,
                row.get::<_, bool>(13)?,
                row.get::<_, f64>(14)?,
                row.get::<_, f64>(15)?,
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

    pub fn find_media_by_hash(&self, content_hash: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT id FROM media WHERE content_hash = ?1 LIMIT 1")
            .map_err(|e| e.to_string())?;
        match stmt.query_row(params![content_hash], |row| row.get::<_, String>(0)) {
            Ok(id) => Ok(Some(id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn insert_media(&self, id: &str, filename: &str, path: &str, media_type: &str, created_at: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO media (id, filename, path, media_type, fit_mode, description, tags, category, created_at) VALUES (?1,?2,?3,?4,'contain','','[]','',?5)",
            params![id, filename, path, media_type, created_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_media_hash(&self, id: &str, content_hash: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("UPDATE media SET content_hash = ?1 WHERE id = ?2", params![content_hash, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_media_probe(
        &self,
        id: &str,
        thumbnail_path: Option<&str>,
        duration: Option<f64>,
        width: Option<i64>,
        height: Option<i64>,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE media SET thumbnail_path = ?1, duration = ?2, width = ?3, height = ?4 WHERE id = ?5",
            params![thumbnail_path.unwrap_or(""), duration, width, height, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_media_playback(&self, id: &str, loop_playback: bool, playback_rate: f64, volume: f64) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE media SET loop_playback = ?1, playback_rate = ?2, volume = ?3 WHERE id = ?4",
            params![loop_playback, playback_rate, volume, id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn relink_media(&self, id: &str, filename: &str, path: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE media SET filename = ?1, path = ?2 WHERE id = ?3",
            params![filename, path, id],
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wordlyte-datadb-test-{}-{}",
            std::process::id(),
            name
        ));
        // Clear leftovers from a previously-interrupted run so quarantine
        // rename targets can never collide across test invocations.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup(dir: &std::path::Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    fn corrupt_files_in(dir: &std::path::Path) -> bool {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .any(|e| e.file_name().to_string_lossy().contains("corrupt-"))
            })
            .unwrap_or(false)
    }

    #[test]
    fn corrupt_file_is_quarantined_and_recreated() {
        let dir = test_dir("c1");
        let path = dir.join("corrupt.db");
        // Write clearly-not-sqlite bytes so SQLite reports NOTADB / CORRUPT.
        std::fs::write(&path, b"this is definitely not a sqlite database file......").unwrap();
        let db = DataDb::open(&path).expect("corrupt DB should be quarantined and recreated");
        // The fresh database is usable.
        assert!(db.kv_set("k", "v").is_ok());
        assert_eq!(db.kv_get("k").unwrap().as_deref(), Some("v"));
        // The damaged file was preserved aside, never deleted.
        assert!(corrupt_files_in(&dir), "damaged database must be quarantined, not deleted");
        cleanup(&dir);
    }

    #[test]
    fn non_corrupt_error_never_quarantines_the_file() {
        let dir = test_dir("c2");
        // A parent path that is a regular file forces SQLITE_CANTOPEN when we
        // try to open `<file>/nested.db` — a permission/IO problem, NOT corruption.
        let blocker = dir.join("not-a-directory");
        std::fs::write(&blocker, b"file").unwrap();
        let path = blocker.join("nested.db");
        let err = match DataDb::open(&path) {
            Ok(_) => panic!("opening a path inside a regular file must fail"),
            Err(e) => e,
        };
        assert!(
            matches!(err, OpenError::Other(_)),
            "a non-corrupt open failure must be Other, got {err:?}"
        );
        assert!(!corrupt_files_in(&dir), "a non-corrupt error must not quarantine the database");
        cleanup(&dir);
    }

    #[test]
    fn classification_identifies_corruption_codes() {
        // SQLITE_NOTADB (26) = "file is not a database" → corruption.
        let notadb = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(26),
            Some("file is not a database".to_string()),
        );
        assert!(is_corruption(&notadb));
        // SQLITE_CORRUPT (11) → corruption.
        let corrupt = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(11),
            Some("database disk image is malformed".to_string()),
        );
        assert!(is_corruption(&corrupt));
        // SQLITE_CANTOPEN (14) is a permission/IO problem → NOT corruption.
        let cantopen = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(14),
            Some("unable to open database file".to_string()),
        );
        assert!(!is_corruption(&cantopen));
        // SQLITE_BUSY (5, transient lock) → NOT corruption.
        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(5),
            Some("database is locked".to_string()),
        );
        assert!(!is_corruption(&busy));
    }
}
