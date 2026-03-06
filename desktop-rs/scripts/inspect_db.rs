use rusqlite::{Connection};

fn main() -> anyhow::Result<()> {
    let conn = Connection::open("src-tauri/bible_data/wordlyte_bible.db")?;
    let mut stmt = conn.prepare("SELECT title, book, chapter, verse, text FROM wordlyte_bible WHERE version = 'KJV' LIMIT 5")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, i32>(2)?,
            row.get::<_, i32>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;

    for row in rows {
        let (title, book, ch, vs, text) = row?;
        println!("DB: {} (ID: {}), {}:{}, Text: {:.30}...", title, book, ch, vs, text);
    }
    Ok(())
}
