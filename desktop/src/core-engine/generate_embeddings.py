import sqlite3
import numpy as np
import os
from pathlib import Path
from sentence_transformers import SentenceTransformer

def generate():
    base_path = Path(__file__).parent.absolute()
    db_path = base_path / "bible_data" / "bible.db"
    embeddings_path = base_path / "bible_data" / "embeddings.npy"
    model_dir = base_path / "models" / "all-MiniLM-L6-v2"
    
    # 1. Load the model (local if possible, else download)
    print("Loading embedding model...")
    if model_dir.exists():
        model = SentenceTransformer(str(model_dir))
    else:
        model = SentenceTransformer('all-MiniLM-L6-v2')
        model.save(str(model_dir))
    
    # 2. Fetch all verses
    print("Fetching verses from database...")
    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()
    cursor.execute("SELECT id, text FROM verses ORDER BY id")
    rows = cursor.fetchall()
    conn.close()
    
    ids = [row[0] for row in rows]
    texts = [row[1] for row in rows]
    
    # 3. Generate Embeddings
    print(f"Generating embeddings for {len(texts)} verses... (this may take a few minutes)")
    embeddings = model.encode(texts, show_progress_bar=True, convert_to_numpy=True)
    
    # 4. Save to disk
    print(f"Saving index to {embeddings_path}...")
    np.save(str(embeddings_path), embeddings)
    print("Indexing Complete!")

if __name__ == "__main__":
    generate()
