import sys
import json
import sqlite3
import re
import os
import io
import numpy as np
from pathlib import Path
from faster_whisper import WhisperModel

class BibleEngine:
    def __init__(self):
        self.base_path = Path(__file__).parent.absolute()
        self.db_path = self.base_path / "bible_data" / "bible.db"
        self.conn = sqlite3.connect(str(self.db_path))
        self.cursor = self.conn.cursor()
        
        # Initialize Whisper
        # Use 'base' for a good balance of speed and accuracy on CPU
        print("Loading Whisper Model...", file=sys.stderr)
        self.whisper = WhisperModel("base", device="cpu", compute_type="int8")
        print("Whisper Ready", file=sys.stderr)

        self.audio_buffer = np.array([], dtype=np.float32)
        self.sample_rate = 16000
        self.window_size = self.sample_rate * 2  # Process 2 seconds at a time

    def process_audio(self, pcm_bytes):
        # Convert bytes to numpy float32
        audio_chunk = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self.audio_buffer = np.append(self.audio_buffer, audio_chunk)

        # Only process if we have enough audio for a segment
        if len(self.audio_buffer) >= self.window_size:
            # Transcribe current buffer
            segments, _ = self.whisper.transcribe(self.audio_buffer, beam_size=5)
            full_text = " ".join([s.text for s in segments]).strip()
            
            if full_text:
                print(json.dumps({"type": "transcription", "text": full_text}))
                sys.stdout.flush()

            # Clear buffer periodically to avoid massive memory usage
            # Keep a small overlap for continuity
            overlap = self.sample_rate // 2
            self.audio_buffer = self.audio_buffer[-overlap:]

    def search_verse(self, reference):
        pattern = r'^(.+?)\s+(\d+):(\d+)$'
        match = re.match(pattern, reference.strip(), re.IGNORECASE)
        if not match: return None
        
        book_input, chapter, verse = match.groups()
        self.cursor.execute("SELECT DISTINCT book FROM verses WHERE book LIKE ?", (f"{book_input}%",))
        row = self.cursor.fetchone()
        if not row: return None
        
        book_name = row[0]
        self.cursor.execute(
            "SELECT text FROM verses WHERE book = ? AND chapter = ? AND verse = ?",
            (book_name, int(chapter), int(verse))
        )
        row = self.cursor.fetchone()
        return {"reference": f"{book_name} {chapter}:{verse}", "text": row[0]} if row else None

    def listen(self):
        # Manual byte-by-byte reading for mixed binary/json stdin
        while True:
            line = sys.stdin.readline()
            if not line: break
            
            if line.startswith("AUDIO:"):
                # Handle binary audio chunk
                try:
                    num_bytes = int(line.split(":")[1])
                    pcm_bytes = sys.stdin.buffer.read(num_bytes)
                    self.process_audio(pcm_bytes)
                except Exception as e:
                    print(json.dumps({"type": "error", "message": f"Audio processing failed: {str(e)}"}), file=sys.stderr)
            else:
                # Handle JSON command
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
