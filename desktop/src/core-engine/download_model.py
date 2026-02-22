from faster_whisper import WhisperModel
import os
from pathlib import Path

def download():
    model_name = "base"
    save_dir = Path("./models")
    save_dir.mkdir(exist_ok=True)
    
    print(f"Downloading '{model_name}' model to {save_dir.absolute()}...")
    
    # This downloads the model weights to the specified directory
    WhisperModel(model_name, device="cpu", compute_type="int8", download_root=str(save_dir))
    
    print("Download Complete!")

if __name__ == "__main__":
    download()
