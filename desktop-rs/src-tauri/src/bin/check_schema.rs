use rusqlite::Connection;
fn main() {
    let conn = Connection::open("src-tauri/bible_data/super_bible.db").expect("Cannot open DB");
    let mut stmt = conn.prepare("PRAGMA table_info(super_bible)").unwrap();
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(1).unwrap();
        Ok(name)
    }).unwrap();
    println!("Columns in super_bible:");
    for row in rows {
        println!("  - {}", row.unwrap());
    }
}
