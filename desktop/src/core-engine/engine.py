import sys
import json
import sqlite3
import re
import os
import io
import numpy as np
from pathlib import Path
from faster_whisper import WhisperModel
from sentence_transformers import SentenceTransformer

class BibleEngine:
    BOOK_NAMES = {
        "genesis": "Genesis", "gen": "Genesis", "gn": "Genesis",
        "exodus": "Exodus", "exod": "Exodus", "ex": "Exodus",
        "leviticus": "Leviticus", "lev": "Leviticus", "lv": "Leviticus",
        "numbers": "Numbers", "num": "Numbers", "nm": "Numbers",
        "deuteronomy": "Deuteronomy", "deut": "Deuteronomy", "dt": "Deuteronomy",
        "joshua": "Joshua", "josh": "Joshua", "jos": "Joshua",
        "judges": "Judges", "judg": "Judges", "jdg": "Judges",
        "ruth": "Ruth", "rth": "Ruth",
        "1 samuel": "1 Samuel", "1samuel": "1 Samuel", "1sam": "1 Samuel", "1sm": "1 Samuel",
        "2 samuel": "2 Samuel", "2samuel": "2 Samuel", "2sam": "2 Samuel", "2sm": "2 Samuel",
        "1 kings": "1 Kings", "1kings": "1 Kings", "1kgs": "1 Kings", "1kg": "1 Kings",
        "2 kings": "2 Kings", "2kings": "2 Kings", "2kgs": "2 Kings", "2kg": "2 Kings",
        "1 chronicles": "1 Chronicles", "1chronicles": "1 Chronicles", "1chr": "1 Chronicles",
        "2 chronicles": "2 Chronicles", "2chronicles": "2 Chronicles", "2chr": "2 Chronicles",
        "ezra": "Ezra", "ezr": "Ezra",
        "nehemiah": "Nehemiah", "neh": "Nehemiah",
        "esther": "Esther", "esth": "Esther", "est": "Esther",
        "job": "Job", "jb": "Job",
        "psalms": "Psalms", "psalm": "Psalms", "ps": "Psalms", "psa": "Psalms",
        "proverbs": "Proverbs", "prov": "Proverbs", "prv": "Proverbs",
        "ecclesiastes": "Ecclesiastes", "eccl": "Ecclesiastes", "ecc": "Ecclesiastes",
        "song of solomon": "Song of Solomon", "song": "Song of Solomon", "sos": "Song of Solomon",
        "isaiah": "Isaiah", "isa": "Isaiah", "is": "Isaiah",
        "jeremiah": "Jeremiah", "jer": "Jeremiah",
        "lamentations": "Lamentations", "lam": "Lamentations",
        "ezekiel": "Ezekiel", "ezek": "Ezekiel", "ezk": "Ezekiel",
        "daniel": "Daniel", "dan": "Daniel", "dn": "Daniel",
        "hosea": "Hosea", "hos": "Hosea",
        "joel": "Joel", "jl": "Joel",
        "amos": "Amos", "am": "Amos",
        "obadiah": "Obadiah", "obad": "Obadiah", "ob": "Obadiah",
        "jonah": "Jonah", "jon": "Jonah",
        "micah": "Micah", "mic": "Micah",
        "nahum": "Nahum", "nah": "Nahum", "na": "Nahum",
        "habakkuk": "Habakkuk", "hab": "Habakkuk",
        "zephaniah": "Zephaniah", "zeph": "Zephaniah", "zep": "Zephaniah",
        "haggai": "Haggai", "hag": "Haggai",
        "zechariah": "Zechariah", "zech": "Zechariah", "zec": "Zechariah",
        "malachi": "Malachi", "mal": "Malachi",
        "matthew": "Matthew", "matt": "Matthew", "mt": "Matthew",
        "mark": "Mark", "mrk": "Mark", "mk": "Mark",
        "luke": "Luke", "lk": "Luke",
        "john": "John", "jn": "John",
        "acts": "Acts", "act": "Acts",
        "romans": "Romans", "rom": "Romans", "rm": "Romans",
        "1 corinthians": "1 Corinthians", "1corinthians": "1 Corinthians", "1cor": "1 Corinthians",
        "2 corinthians": "2 Corinthians", "2corinthians": "2 Corinthians", "2cor": "2 Corinthians",
        "galatians": "Galatians", "gal": "Galatians",
        "ephesians": "Ephesians", "eph": "Ephesians",
        "philippians": "Philippians", "phil": "Philippians", "php": "Philippians",
        "colossians": "Colossians", "col": "Colossians",
        "1 thessalonians": "1 Thessalonians", "1thessalonians": "1 Thessalonians", "1thess": "1 Thessalonians",
        "2 thessalonians": "2 Thessalonians", "2thessalonians": "2 Thessalonians", "2thess": "2 Thessalonians",
        "1 timothy": "1 Timothy", "1timothy": "1 Timothy", "1tim": "1 Timothy",
        "2 timothy": "2 Timothy", "2timothy": "2 Timothy", "2tim": "2 Timothy",
        "titus": "Titus", "tit": "Titus",
        "philemon": "Philemon", "philem": "Philemon", "phm": "Philemon",
        "hebrews": "Hebrews", "heb": "Hebrews",
        "james": "James", "jas": "James", "jm": "James",
        "1 peter": "1 Peter", "1peter": "1 Peter", "1pet": "1 Peter",
        "2 peter": "2 Peter", "2peter": "2 Peter", "2pet": "2 Peter",
        "1 john": "1 John", "1john": "1 John", "1jn": "1 John",
        "2 john": "2 John", "2john": "2 John", "2jn": "2 John",
        "3 john": "3 John", "3john": "3 John", "3jn": "3 John",
        "jude": "Jude", "jud": "Jude",
        "revelation": "Revelation", "rev": "Revelation", "rv": "Revelation",
    }

    def __init__(self):
        self.base_path = Path(__file__).parent.absolute()
        self.db_path = self.base_path / "bible_data" / "bible.db"
        self.embeddings_path = self.base_path / "bible_data" / "embeddings.npy"
        
        self.conn = sqlite3.connect(str(self.db_path))
        self.cursor = self.conn.cursor()
        
        # Initialize Whisper
        self.model_dir = self.base_path / "models"
        # Point to the specific snapshot directory for faster-whisper
        whisper_snapshot = self.model_dir / "models--Systran--faster-whisper-base" / "snapshots" / "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
        
        print(f"Loading Whisper...", file=sys.stderr)
        if whisper_snapshot.exists():
            self.whisper = WhisperModel(str(whisper_snapshot), device="cpu", compute_type="int8")
        else:
            self.whisper = WhisperModel("base", device="cpu", compute_type="int8")

        # Initialize Embedding Model (Semantic Search)
        print(f"Loading Semantic Engine...", file=sys.stderr)
        embed_model_path = self.model_dir / "all-MiniLM-L6-v2"
        if embed_model_path.exists():
            self.embedder = SentenceTransformer(str(embed_model_path))
        else:
            self.embedder = SentenceTransformer('all-MiniLM-L6-v2')

        # Load Pre-computed Embeddings
        if self.embeddings_path.exists():
            print(f"Loading Verse Index...", file=sys.stderr)
            self.verse_embeddings = np.load(str(self.embeddings_path))
            # Pre-load all verses into memory for fast semantic lookup
            self.cursor.execute("SELECT book, chapter, verse, text FROM verses ORDER BY id")
            self.verse_cache = self.cursor.fetchall()
        else:
            self.verse_embeddings = None
            print(f"WARNING: Verse Index not found at {self.embeddings_path}", file=sys.stderr)

        self.audio_buffer = np.array([], dtype=np.float32)
        self.sample_rate = 16000
        self.window_size = self.sample_rate * 3  # 3s window for better context
        print("Whisper Ready", file=sys.stderr)

    def semantic_search(self, text, top_k=3, threshold=0.45):
        if self.verse_embeddings is None: return []
        
        # 1. Encode spoken text
        query_embedding = self.embedder.encode([text], convert_to_numpy=True)
        
        # 2. Compute Cosine Similarity
        similarities = np.dot(self.verse_embeddings, query_embedding.T).flatten()
        
        # 3. Get Top Results
        top_indices = np.argsort(similarities)[::-1][:top_k]
        results = []
        for idx in top_indices:
            score = float(similarities[idx])
            if score >= threshold:
                book, chap, verse, content = self.verse_cache[idx]
                results.append({
                    "reference": f"{book} {chap}:{verse}",
                    "text": content,
                    "score": score,
                    "type": "semantic"
                })
        return results

    def process_audio(self, pcm_bytes):
        audio_chunk = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self.audio_buffer = np.append(self.audio_buffer, audio_chunk)

        if len(self.audio_buffer) >= self.window_size:
            segments, _ = self.whisper.transcribe(self.audio_buffer, beam_size=5)
            full_text = " ".join([s.text for s in segments]).strip()
            
            if full_text and len(full_text) > 10:
                # 1. Explicit Reference Search (Regex)
                explicit_refs = self.detect_bible_references(full_text)
                explicit_matches = []
                for ref in explicit_refs:
                    res = self.search_verse(ref)
                    if res:
                        explicit_matches.append(res)
                
                # 2. Semantic Search (Conceptual)
                semantic_results = self.semantic_search(full_text)
                
                print(json.dumps({
                    "type": "transcription", 
                    "text": full_text,
                    "matches": explicit_matches,
                    "semantic_matches": semantic_results
                }))
                sys.stdout.flush()

            overlap = self.sample_rate 
            self.audio_buffer = self.audio_buffer[-overlap:]

    def normalize_book(self, book_text: str) -> str:
        book_lower = book_text.lower().strip()
        if book_lower in self.BOOK_NAMES:
            return self.BOOK_NAMES[book_lower]
        for key, value in self.BOOK_NAMES.items():
            if book_lower.startswith(key) or key.startswith(book_lower):
                return value
        return None

    def detect_bible_references(self, text: str) -> list[str]:
        references = []
        pattern1 = r'\b([1-3]?\s*\w+)\s+(\d+):(\d+)(?:-(\d+))?\b'
        pattern2 = r'\b([1-3]?\s*\w+)\s+chapter\s+(\d+)\s+verse\s+(\d+)\b'
        pattern3 = r'\b(first|second|third|1st|2nd|3rd)\s+(\w+)\s+(?:chapter\s+)?(\d+)(?:\s+verse\s+(\d+))?\b'
        
        for pattern, p_type in [(pattern1, 'std'), (pattern2, 'spoken'), (pattern3, 'ordinal')]:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                groups = match.groups()
                if p_type == 'std' or p_type == 'spoken':
                    book, chap, verse = groups[0], groups[1], groups[2]
                    norm = self.normalize_book(book)
                    if norm: references.append(f"{norm} {chap}:{verse}")
                elif p_type == 'ordinal':
                    ord_val, book, chap, verse = groups
                    ord_map = {'first': '1', 'second': '2', 'third': '3', '1st': '1', '2nd': '2', '3rd': '3'}
                    num = ord_map.get(ord_val.lower(), ord_val)
                    norm = self.normalize_book(f"{num} {book}")
                    if norm and verse: references.append(f"{norm} {chap}:{verse}")
        
        return list(set(references))

    def search_verse(self, reference):
        pattern = r'^(.+?)\s+(\d+):(\d+)$'
        match = re.match(pattern, reference.strip(), re.IGNORECASE)
        if not match: return None
        
        book_input, chapter, verse = match.groups()
        normalized_book = self.normalize_book(book_input)
        if not normalized_book: return None
        
        self.cursor.execute(
            "SELECT text FROM verses WHERE book = ? AND chapter = ? AND verse = ?",
            (normalized_book, int(chapter), int(verse))
        )
        row = self.cursor.fetchone()
        return {"reference": f"{normalized_book} {chapter}:{verse}", "text": row[0], "type": "explicit"} if row else None

    def listen(self):
        while True:
            line = sys.stdin.readline()
            if not line: break
            
            if line.startswith("AUDIO:"):
                try:
                    num_bytes = int(line.split(":")[1])
                    pcm_bytes = sys.stdin.buffer.read(num_bytes)
                    self.process_audio(pcm_bytes)
                except Exception as e:
                    print(json.dumps({"type": "error", "message": str(e)}), file=sys.stderr)
            else:
                try:
                    cmd = json.loads(line)
                    if cmd.get("action") == "search":
                        res = self.search_verse(cmd.get("reference"))
                        print(json.dumps({"type": "search_result", "data": res}))
                        sys.stdout.flush()
                except:
                    pass

if __name__ == "__main__":
    engine = BibleEngine()
    engine.listen()
