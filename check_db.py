import sqlite3
import os

db_path = "desktop-rs/src-tauri/bible_data/bible.db"
if not os.path.exists(db_path):
    print(f"Error: {db_path} does not exist.")
    exit(1)

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
    tables = cursor.fetchall()
    print(f"Tables: {tables}")
    
    if ('verses',) in tables:
        cursor.execute("SELECT COUNT(*) FROM verses;")
        count = cursor.fetchone()[0]
        print(f"Verse count: {count}")
        
        cursor.execute("PRAGMA table_info(verses);")
        info = cursor.fetchall()
        print(f"Table Info (verses): {info}")
    else:
        print("Error: 'verses' table not found.")
        
    conn.close()
except Exception as e:
    print(f"Error: {e}")
