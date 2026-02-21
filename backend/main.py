"""
Extended FastAPI Backend with Speech Recognition for Pastor's Voice
Detects Bible references and paraphrases in real-time

Additional Requirements:
pip install faster-whisper openai-whisper torch torchaudio spacy
python -m spacy download en_core_web_sm
"""

from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict
from sentence_transformers import SentenceTransformer
import chromadb
from chromadb.config import Settings
import json
import sqlite3
import urllib.request
from pathlib import Path
import re
import io
import base64
import tempfile
import os

# Speech recognition imports
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    print("Warning: faster-whisper not available. Install with: pip install faster-whisper")
    WHISPER_AVAILABLE = False

try:
    import spacy
    nlp = spacy.load("en_core_web_sm")
    SPACY_AVAILABLE = True
except:
    print("Warning: spacy not available. Install with: pip install spacy && python -m spacy download en_core_web_sm")
    SPACY_AVAILABLE = False

app = FastAPI(title="Bible Search API with Speech Recognition")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize models
print("Loading embedding model...")
embedding_model = SentenceTransformer('all-MiniLM-L6-v2')

# Initialize Whisper for speech recognition
whisper_model = None
if WHISPER_AVAILABLE:
    print("Loading Whisper model for speech recognition...")
    # Using 'base' model for balance of speed and accuracy
    # Options: tiny, base, small, medium, large
    whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    print("Whisper model loaded")

# Initialize ChromaDB with persistence
EMBEDDINGS_DIR = "./bible_embeddings"
chroma_client = chromadb.PersistentClient(path=EMBEDDINGS_DIR)

bible_collection = None
DB_PATH = "./bible_data/bible.db"

# Active WebSocket connections
active_connections: List[WebSocket] = []

class VerseResponse(BaseModel):
    reference: str
    text: str
    book: str
    chapter: int
    verse: int
    score: Optional[float] = None

class SearchRequest(BaseModel):
    query: str
    limit: int = 10

class DirectSearchRequest(BaseModel):
    reference: str

class TranscriptionResponse(BaseModel):
    text: str
    detected_references: List[str]
    detected_paraphrases: List[str]
    verses: List[VerseResponse]

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

# Book name patterns for detection
BOOK_PATTERNS = [
    r'\b(Genesis|Gen)\b', r'\b(Exodus|Ex|Exod)\b', r'\b(Leviticus|Lev)\b',
    r'\b(Numbers|Num)\b', r'\b(Deuteronomy|Deut|Dt)\b', r'\b(Joshua|Josh)\b',
    r'\b(Judges|Judg)\b', r'\b(Ruth)\b', r'\b(1\s*Samuel|First\s*Samuel|1\s*Sam)\b',
    r'\b(2\s*Samuel|Second\s*Samuel|2\s*Sam)\b', r'\b(1\s*Kings|First\s*Kings|1\s*Kgs)\b',
    r'\b(2\s*Kings|Second\s*Kings|2\s*Kgs)\b', r'\b(1\s*Chronicles|1\s*Chr)\b',
    r'\b(2\s*Chronicles|2\s*Chr)\b', r'\b(Ezra)\b', r'\b(Nehemiah|Neh)\b',
    r'\b(Esther|Est)\b', r'\b(Job)\b', r'\b(Psalms?|Ps|Psa)\b',
    r'\b(Proverbs|Prov)\b', r'\b(Ecclesiastes|Eccl)\b', r'\b(Song\s*of\s*Solomon|Song)\b',
    r'\b(Isaiah|Isa)\b', r'\b(Jeremiah|Jer)\b', r'\b(Lamentations|Lam)\b',
    r'\b(Ezekiel|Ezek)\b', r'\b(Daniel|Dan)\b', r'\b(Hosea|Hos)\b',
    r'\b(Joel)\b', r'\b(Amos)\b', r'\b(Obadiah|Obad)\b', r'\b(Jonah)\b',
    r'\b(Micah|Mic)\b', r'\b(Nahum|Nah)\b', r'\b(Habakkuk|Hab)\b',
    r'\b(Zephaniah|Zeph)\b', r'\b(Haggai|Hag)\b', r'\b(Zechariah|Zech)\b',
    r'\b(Malachi|Mal)\b', r'\b(Matthew|Matt|Mt)\b', r'\b(Mark|Mk)\b',
    r'\b(Luke|Lk)\b', r'\b(John|Jn)\b', r'\b(Acts)\b',
    r'\b(Romans|Rom)\b', r'\b(1\s*Corinthians|First\s*Corinthians|1\s*Cor)\b',
    r'\b(2\s*Corinthians|Second\s*Corinthians|2\s*Cor)\b', r'\b(Galatians|Gal)\b',
    r'\b(Ephesians|Eph)\b', r'\b(Philippians|Phil)\b', r'\b(Colossians|Col)\b',
    r'\b(1\s*Thessalonians|1\s*Thess)\b', r'\b(2\s*Thessalonians|2\s*Thess)\b',
    r'\b(1\s*Timothy|1\s*Tim)\b', r'\b(2\s*Timothy|2\s*Tim)\b',
    r'\b(Titus|Tit)\b', r'\b(Philemon|Philem)\b', r'\b(Hebrews|Heb)\b',
    r'\b(James|Jas)\b', r'\b(1\s*Peter|First\s*Peter|1\s*Pet)\b',
    r'\b(2\s*Peter|Second\s*Peter|2\s*Pet)\b', r'\b(1\s*John|First\s*John|1\s*Jn)\b',
    r'\b(2\s*John|Second\s*John|2\s*Jn)\b', r'\b(3\s*John|Third\s*John|3\s*Jn)\b',
    r'\b(Jude)\b', r'\b(Revelation|Rev)\b'
]

def get_db_connection():
    """Get SQLite database connection"""
    return sqlite3.connect(DB_PATH)

def detect_bible_references(text: str) -> List[str]:
    """
    Enhanced detection for Bible references
    Handles both written and spoken formats
    """
    references = []
    text_lower = text.lower()
    
    # Pattern 1: Standard written format "John 3:16" or "John 3:16-18"
    pattern1 = r'\b([1-3]?\s*\w+)\s+(\d+):(\d+)(?:-(\d+))?\b'
    
    # Pattern 2: Spoken format "John Chapter 3 verse 16"
    pattern2 = r'\b([1-3]?\s*\w+)\s+chapter\s+(\d+)\s+verse\s+(\d+)(?:\s+(?:through|to|thru)\s+(?:verse\s+)?(\d+))?\b'
    
    # Pattern 3: "John Chapter 3" (entire chapter)
    pattern4 = r'\b([1-3]?\s*\w+)\s+chapter\s+(\d+)\b(?!\s+verse)'
    
    # Pattern 4: Variations like "First John", "Second Corinthians"
    pattern6 = r'\b(first|second|third|1st|2nd|3rd)\s+(\w+)\s+(?:chapter\s+)?(\d+)(?:\s+verse\s+(\d+)(?:\s+(?:through|to)\s+(\d+))?)?\b'
    
    all_patterns = [
        (pattern1, 'standard'),
        (pattern2, 'spoken'),
        (pattern4, 'spoken_chapter'),
        (pattern6, 'ordinal')
    ]
    
    def normalize_book(book_text: str) -> str:
        """Normalize book name"""
        book_lower = book_text.lower().strip()
        if book_lower in BOOK_NAMES:
            return BOOK_NAMES[book_lower]
        for key, value in BOOK_NAMES.items():
            if book_lower.startswith(key) or key.startswith(book_lower):
                return value
        return None
    
    for pattern, pattern_type in all_patterns:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        
        for match in matches:
            groups = match.groups()
            
            if pattern_type == 'spoken':
                book, chapter, verse, end_verse = groups
                normalized = normalize_book(book)
                if normalized:
                    if end_verse:
                        references.append(f"{normalized} {chapter}:{verse}-{end_verse}")
                    else:
                        references.append(f"{normalized} {chapter}:{verse}")
            
            elif pattern_type == 'standard':
                book, chapter, verse, end_verse = groups
                normalized = normalize_book(book)
                if normalized:
                    if end_verse:
                        references.append(f"{normalized} {chapter}:{verse}-{end_verse}")
                    else:
                        references.append(f"{normalized} {chapter}:{verse}")
            
            elif pattern_type == 'spoken_chapter':
                book, chapter = groups
                normalized = normalize_book(book)
                if normalized:
                    references.append(f"{normalized} {chapter}")
            
            elif pattern_type == 'ordinal':
                ordinal, book, chapter, verse, end_verse = groups
                ordinal_map = {
                    'first': '1', '1st': '1',
                    'second': '2', '2nd': '2',
                    'third': '3', '3rd': '3'
                }
                num = ordinal_map.get(ordinal.lower(), ordinal)
                full_book = f"{num} {book}"
                normalized = normalize_book(full_book)
                
                if normalized:
                    if verse:
                        if end_verse:
                            references.append(f"{normalized} {chapter}:{verse}-{end_verse}")
                        else:
                            references.append(f"{normalized} {chapter}:{verse}")
                    else:
                        references.append(f"{normalized} {chapter}")
    
    # Remove duplicates
    seen = set()
    unique_refs = []
    for ref in references:
        if ref not in seen:
            seen.add(ref)
            unique_refs.append(ref)
    
    return unique_refs

def detect_paraphrases(text: str) -> List[str]:
    """Detect potential Bible paraphrases using sentence structure"""
    paraphrases = []
    
    if not SPACY_AVAILABLE:
        return paraphrases
    
    # Parse text with spacy
    doc = nlp(text)
    
    # Look for complete sentences that might be quotes or paraphrases
    for sent in doc.sents:
        sent_text = sent.text.strip()
        
        # Skip if it's just a reference
        if any(re.search(pattern, sent_text, re.IGNORECASE) for pattern in BOOK_PATTERNS):
            continue
        
        # Look for indicators of quotes/paraphrases
        indicators = [
            'says', 'said', 'scripture', 'bible', 'word', 'verse',
            'written', 'reads', 'tells us', 'reminds us', 'teaches'
        ]
        
        sent_lower = sent_text.lower()
        if any(indicator in sent_lower for indicator in indicators):
            # Extract the potential quote (often after "says" or similar)
            for indicator in indicators:
                if indicator in sent_lower:
                    parts = sent_text.split(indicator, 1)
                    if len(parts) > 1:
                        quote = parts[1].strip(' ,"\'')
                        if len(quote) > 20:  # Minimum length for meaningful search
                            paraphrases.append(quote)
                    break
        
        # Also add longer sentences that don't contain references but sound biblical
        elif len(sent_text) > 30 and len(sent_text.split()) > 5:
            # Check if it sounds like a biblical statement
            biblical_words = ['lord', 'god', 'heaven', 'blessed', 'righteous', 'faith', 'love']
            if any(word in sent_lower for word in biblical_words):
                paraphrases.append(sent_text)
    
    return paraphrases

async def search_for_verses(references: List[str], paraphrases: List[str]) -> List[Dict]:
    """Search for verses based on references and paraphrases"""
    all_verses = []
    seen_references = set()
    
    # Search explicit references
    for ref in references:
        try:
            # Use existing direct search logic
            from main import parse_reference, get_verses_from_db
            parsed = parse_reference(ref)
            verses = get_verses_from_db(parsed)
            
            for v in verses:
                if v['reference'] not in seen_references:
                    all_verses.append(v)
                    seen_references.add(v['reference'])
        except:
            continue
    
    # Search paraphrases semantically
    for paraphrase in paraphrases:
        try:
            # Use semantic search
            query_embedding = embedding_model.encode([paraphrase])[0]
            results = bible_collection.query(
                query_embeddings=[query_embedding.tolist()],
                n_results=3  # Top 3 matches per paraphrase
            )
            
            if results['metadatas'] and len(results['metadatas'][0]) > 0:
                for i, metadata in enumerate(results['metadatas'][0]):
                    # Only include high-confidence matches (>50% similarity)
                    similarity = 1 - results['distances'][0][i]
                    if similarity > 0.5 and metadata['reference'] not in seen_references:
                        verse_dict = {
                            'reference': metadata['reference'],
                            'text': metadata['text'],
                            'book': metadata['book'],
                            'chapter': metadata['chapter'],
                            'verse': metadata['verse'],
                            'score': similarity
                        }
                        all_verses.append(verse_dict)
                        seen_references.add(metadata['reference'])
        except:
            continue
    
    return all_verses

@app.post("/api/speech/transcribe", response_model=TranscriptionResponse)
async def transcribe_audio(audio: UploadFile = File(...)):
    """
    Transcribe audio and detect Bible references
    Accepts: WAV, MP3, OGG, FLAC audio files
    """
    if not WHISPER_AVAILABLE:
        raise HTTPException(status_code=503, detail="Speech recognition not available")
    
    try:
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            content = await audio.read()
            tmp_file.write(content)
            tmp_file_path = tmp_file.name
        
        # Transcribe with Whisper
        segments, info = whisper_model.transcribe(tmp_file_path, beam_size=5)
        
        # Combine all segments
        full_text = " ".join([segment.text for segment in segments])
        
        # Clean up temp file
        os.unlink(tmp_file_path)
        
        # Detect references and paraphrases
        references = detect_bible_references(full_text)
        paraphrases = detect_paraphrases(full_text)

        print(references)
        
        # Search for verses
        verses_data = await search_for_verses(references, paraphrases)
        
        # Format response
        verses = [
            VerseResponse(
                reference=v['reference'],
                text=v['text'],
                book=v['book'],
                chapter=v['chapter'],
                verse=v['verse'],
                score=v.get('score')
            )
            for v in verses_data
        ]
        
        return TranscriptionResponse(
            text=full_text,
            detected_references=references,
            detected_paraphrases=paraphrases,
            verses=verses
        )
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")

@app.websocket("/ws/live-transcription")
async def websocket_live_transcription(websocket: WebSocket):
    """
    WebSocket endpoint for live audio streaming and transcription
    Client sends audio chunks, server responds with transcriptions and verses
    """
    await websocket.accept()
    active_connections.append(websocket)
    
    if not WHISPER_AVAILABLE:
        await websocket.send_json({
            "error": "Speech recognition not available"
        })
        await websocket.close()
        return
    
    try:
        audio_buffer = io.BytesIO()
        
        while True:
            # Receive audio chunk from client
            data = await websocket.receive_json()
            
            if data.get("type") == "audio_chunk":
                # Accumulate audio data
                audio_bytes = base64.b64decode(data["audio"])
                audio_buffer.write(audio_bytes)
                
            elif data.get("type") == "process":
                # Process accumulated audio
                audio_buffer.seek(0)
                
                # Save to temporary file
                with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
                    tmp_file.write(audio_buffer.read())
                    tmp_file_path = tmp_file.name
                
                # Transcribe
                segments, info = whisper_model.transcribe(tmp_file_path, beam_size=5)
                full_text = " ".join([segment.text for segment in segments])
                
                # Clean up
                os.unlink(tmp_file_path)
                audio_buffer = io.BytesIO()  # Reset buffer
                
                # Detect and search
                references = detect_bible_references(full_text)
                paraphrases = detect_paraphrases(full_text)
                verses_data = await search_for_verses(references, paraphrases)
                
                # Send response
                await websocket.send_json({
                    "type": "transcription",
                    "text": full_text,
                    "references": references,
                    "paraphrases": paraphrases,
                    "verses": [
                        {
                            "reference": v['reference'],
                            "text": v['text'],
                            "book": v['book'],
                            "chapter": v['chapter'],
                            "verse": v['verse'],
                            "score": v.get('score')
                        }
                        for v in verses_data
                    ]
                })
    
    except WebSocketDisconnect:
        active_connections.remove(websocket)
    except Exception as e:
        await websocket.send_json({"error": str(e)})
        active_connections.remove(websocket)

@app.get("/api/speech/status")
async def speech_status():
    """Check if speech recognition is available"""
    return {
        "whisper_available": WHISPER_AVAILABLE,
        "spacy_available": SPACY_AVAILABLE,
        "model": "faster-whisper base" if WHISPER_AVAILABLE else None
    }

def get_db_connection():
    """Get SQLite database connection"""
    return sqlite3.connect(DB_PATH)

def download_bible():
    """Download Bible JSON from GitHub"""
    bible_dir = Path("./bible_data")
    bible_dir.mkdir(exist_ok=True)
    
    bible_file = bible_dir / "kjv.json"
    
    if bible_file.exists():
        print("Bible file already exists locally")
        return str(bible_file)
    
    print("Downloading Bible from GitHub...")
    url = "https://raw.githubusercontent.com/thiagobodruk/bible/master/json/en_kjv.json"
    
    try:
        urllib.request.urlretrieve(url, bible_file)
        print(f"Bible downloaded successfully")
        return str(bible_file)
    except Exception as e:
        print(f"Error downloading Bible: {e}")
        raise

def initialize_sqlite_db():
    """Initialize SQLite database with Bible data"""
    db_path = Path(DB_PATH)
    
    if db_path.exists():
        print("SQLite database already exists")
        return
    
    print("Creating SQLite database...")
    db_path.parent.mkdir(exist_ok=True)
    
    # Download Bible data
    bible_file = download_bible()
    
    # Load JSON
    with open(bible_file, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)
    
    # Create database
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Create tables
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS verses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            book TEXT NOT NULL,
            chapter INTEGER NOT NULL,
            verse INTEGER NOT NULL,
            text TEXT NOT NULL,
            reference TEXT NOT NULL,
            UNIQUE(book, chapter, verse)
        )
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_book_chapter 
        ON verses(book, chapter)
    ''')
    
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_reference 
        ON verses(reference)
    ''')
    
    # Insert data
    print("Inserting verses into database...")
    verse_count = 0
    
    # Book name mapping from abbreviation
    book_names = [
        "Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy",
        "Joshua", "Judges", "Ruth", "1 Samuel", "2 Samuel",
        "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra",
        "Nehemiah", "Esther", "Job", "Psalms", "Proverbs",
        "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations",
        "Ezekiel", "Daniel", "Hosea", "Joel", "Amos",
        "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk",
        "Zephaniah", "Haggai", "Zechariah", "Malachi",
        "Matthew", "Mark", "Luke", "John", "Acts",
        "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians",
        "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians", "1 Timothy",
        "2 Timothy", "Titus", "Philemon", "Hebrews", "James",
        "1 Peter", "2 Peter", "1 John", "2 John", "3 John",
        "Jude", "Revelation"
    ]
    
    for book_idx, book in enumerate(data):
        book_name = book.get('name', book_names[book_idx] if book_idx < len(book_names) else f"Book {book_idx + 1}")
        
        # chapters is a list of lists (each chapter is a list of verse strings)
        for chapter_idx, chapter_verses in enumerate(book['chapters']):
            chapter_num = chapter_idx + 1
            
            for verse_idx, verse_text in enumerate(chapter_verses):
                verse_num = verse_idx + 1
                text = verse_text.strip() if isinstance(verse_text, str) else str(verse_text).strip()
                reference = f"{book_name} {chapter_num}:{verse_num}"
                
                cursor.execute(
                    'INSERT OR IGNORE INTO verses (book, chapter, verse, text, reference) VALUES (?, ?, ?, ?, ?)',
                    (book_name, chapter_num, verse_num, text, reference)
                )
                verse_count += 1
    
    conn.commit()
    conn.close()
    
    print(f"Database created with {verse_count} verses")

def get_all_verses_from_db():
    """Get all verses from database for embedding indexing"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('SELECT id, book, chapter, verse, text, reference FROM verses ORDER BY id')
    rows = cursor.fetchall()
    
    conn.close()
    
    verses = []
    for row in rows:
        verses.append({
            'id': row[0],
            'book': row[1],
            'chapter': row[2],
            'verse': row[3],
            'text': row[4],
            'reference': row[5]
        })
    
    return verses

def parse_reference(reference: str) -> Dict:
    """Parse Bible reference string"""
    reference = reference.strip()
    
    # Pattern: "Book Chapter:Verse" or "Book Chapter:Verse-Verse"
    pattern = r'^(.+?)\s+(\d+)(?::(\d+))?(?:-(\d+))?$'
    match = re.match(pattern, reference, re.IGNORECASE)
    
    if not match:
        raise ValueError(f"Invalid reference format: {reference}")
    
    book_input = match.group(1).strip().lower()
    chapter = int(match.group(2))
    start_verse = int(match.group(3)) if match.group(3) else None
    end_verse = int(match.group(4)) if match.group(4) else start_verse
    
    # Find the book name
    book_name = BOOK_NAMES.get(book_input)
    if not book_name:
        for key, value in BOOK_NAMES.items():
            if key.startswith(book_input):
                book_name = value
                break
    
    if not book_name:
        raise ValueError(f"Book not found: {book_input}")
    
    return {
        'book': book_name,
        'chapter': chapter,
        'start_verse': start_verse,
        'end_verse': end_verse
    }

def get_verses_from_db(parsed_ref: Dict) -> List[Dict]:
    """Get verses from database based on parsed reference"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    book = parsed_ref['book']
    chapter = parsed_ref['chapter']
    start_verse = parsed_ref['start_verse']
    end_verse = parsed_ref['end_verse']
    
    if start_verse is None:
        # Get entire chapter
        cursor.execute(
            'SELECT book, chapter, verse, text, reference FROM verses WHERE book = ? AND chapter = ? ORDER BY verse',
            (book, chapter)
        )
    else:
        # Get verse range
        cursor.execute(
            'SELECT book, chapter, verse, text, reference FROM verses WHERE book = ? AND chapter = ? AND verse BETWEEN ? AND ? ORDER BY verse',
            (book, chapter, start_verse, end_verse or start_verse)
        )
    
    rows = cursor.fetchall()
    conn.close()
    
    if not rows:
        raise ValueError(f"No verses found for reference")
    
    verses = []
    for row in rows:
        verses.append({
            'book': row[0],
            'chapter': row[1],
            'verse': row[2],
            'text': row[3],
            'reference': row[4]
        })
    
    return verses

def initialize_embeddings():
    """Initialize or load the embeddings database"""
    global bible_collection
    
    # First, get the expected verse count from SQLite
    verses = get_all_verses_from_db()
    expected_count = len(verses)
    
    try:
        # Try to get existing collection
        bible_collection = chroma_client.get_collection(name="bible_verses")
        actual_count = bible_collection.count()
        
        # Check if the collection has the right number of verses
        if actual_count == expected_count:
            print(f"✓ Loaded existing embeddings collection with {actual_count} verses")
            return
        else:
            print(f"⚠ Collection has {actual_count} verses, expected {expected_count}. Rebuilding...")
            chroma_client.delete_collection(name="bible_verses")
            bible_collection = None
            
    except chromadb.errors.NotFoundError:
        print("No existing embeddings collection found. Creating new one...")
    except Exception as e:
        print(f"⚠ Error loading collection: {e}. Creating new one...")
        bible_collection = None
    
    # Create new collection if needed
    if bible_collection is None:
        bible_collection = chroma_client.create_collection(
            name="bible_verses",
            metadata={"description": "Bible verses with embeddings"}
        )
        
        print(f"Creating embeddings for {len(verses)} verses...")
        
        # Create embeddings in batches
        batch_size = 1000
        for i in range(0, len(verses), batch_size):
            batch = verses[i:i+batch_size]
            texts = [v['text'] for v in batch]
            
            print(f"Processing batch {i//batch_size + 1}/{(len(verses)-1)//batch_size + 1}...")
            embeddings = embedding_model.encode(texts, show_progress_bar=True)
            
            bible_collection.add(
                embeddings=embeddings.tolist(),
                documents=texts,
                metadatas=[{
                    'reference': v['reference'],
                    'book': v['book'],
                    'chapter': v['chapter'],
                    'verse': v['verse'],
                    'text': v['text']
                } for v in batch],
                ids=[f"verse_{v['id']}" for v in batch]
            )
        
        print(f"✓ Initialized embeddings collection with {len(verses)} verses")

@app.on_event("startup")
async def startup_event():
    """Initialize on startup"""
    initialize_sqlite_db()
    initialize_embeddings()

@app.get("/")
async def root():
    return {
        "message": "Bible Search API - SQLite + Vector Database",
        "database": "SQLite for structured data, ChromaDB for semantic search",
        "endpoints": {
            "semantic_search": "/api/search/semantic",
            "direct_search": "/api/search/direct",
            "health": "/api/health"
        }
    }

@app.get("/api/health")
async def health():
    """Health check endpoint"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM verses')
    verse_count = cursor.fetchone()[0]
    conn.close()
    
    return {
        "status": "healthy",
        "verses_in_db": verse_count,
        "verses_indexed": bible_collection.count() if bible_collection else 0,
        "database": "SQLite + ChromaDB"
    }

@app.post("/api/search/semantic", response_model=List[VerseResponse])
async def semantic_search(request: SearchRequest):
    """Search for verses using semantic similarity"""
    if not bible_collection:
        raise HTTPException(status_code=503, detail="Database not initialized")
    
    try:
        query_embedding = embedding_model.encode([request.query])[0]
        
        results = bible_collection.query(
            query_embeddings=[query_embedding.tolist()],
            n_results=min(request.limit, 50)
        )
        
        verses = []
        if results['metadatas'] and len(results['metadatas'][0]) > 0:
            for i, metadata in enumerate(results['metadatas'][0]):
                verses.append(VerseResponse(
                    reference=metadata['reference'],
                    text=metadata['text'],
                    book=metadata['book'],
                    chapter=metadata['chapter'],
                    verse=metadata['verse'],
                    score=1 - results['distances'][0][i]
                ))
        
        return verses
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

@app.post("/api/search/direct", response_model=List[VerseResponse])
async def direct_search(request: DirectSearchRequest):
    """Direct search by Bible reference"""
    try:
        parsed_ref = parse_reference(request.reference)
        verses_data = get_verses_from_db(parsed_ref)
        
        return [
            VerseResponse(
                reference=v['reference'],
                text=v['text'],
                book=v['book'],
                chapter=v['chapter'],
                verse=v['verse']
            )
            for v in verses_data
        ]
    
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")

@app.get("/api/books")
async def list_books():
    """List all available books"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT book FROM verses ORDER BY id')
    books = [row[0] for row in cursor.fetchall()]
    conn.close()
    
    return {
        "books": books,
        "count": len(books)
    }

@app.post("/api/rebuild-index")
async def rebuild_index():
    """Rebuild the embeddings index"""
    try:
        global bible_collection
        
        try:
            chroma_client.delete_collection(name="bible_verses")
        except:
            pass
        
        bible_collection = None
        initialize_embeddings()
        
        return {
            "status": "success",
            "verses_indexed": bible_collection.count()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Rebuild failed: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8111, reload=True)
