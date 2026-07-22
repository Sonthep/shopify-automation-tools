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
    # Extract batch number from filename (e.g. rename_batch5.py -> 5)
    file_name = Path(__file__).stem
    import re
    m = re.search(r'\d+', file_name)
    batch_num = int(m.group()) if m else 1
    process_batch(batch_num)
