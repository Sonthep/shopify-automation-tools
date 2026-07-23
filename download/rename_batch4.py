"""
Wrapper script delegating to unified download/rename_batch.py
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from download.rename_batch import process_batch

if __name__ == "__main__":
    process_batch(4)
