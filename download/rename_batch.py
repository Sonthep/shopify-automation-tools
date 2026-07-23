"""
Unified Image Batch Renaming Script.
Renames image product files based on SKU order CSV files.
Replaces individual rename_batch1.py ... rename_batch7.py scripts.

Usage:
  python download/rename_batch.py --batch 1
  python download/rename_batch.py --batch 5
  python download/rename_batch.py --all
"""

import os
import sys
import csv
import re
import shutil
import argparse
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from shopify_client import resolve_path


def sanitize_filename(name: str) -> str:
    """Sanitize string to be safe for filenames."""
    return re.sub(r'[<>:\"/\\|?*]', '_', name.strip())


def extract_num(filename: str) -> int:
    """Extract first sequence of numbers from filename for sorting."""
    m = re.search(r'\d+', filename)
    return int(m.group()) if m else 0


def process_batch(batch_num: int, base_dir: Path | None = None, csv_path: Path | None = None) -> bool:
    """Process image renaming for a specific batch number."""
    if base_dir is None:
        # Default base image folder in User Pictures
        base_dir = Path.home() / "Pictures" / "image_product"
    
    if csv_path is None:
        csv_path = PROJECT_ROOT / "download" / f"embedded_sku_order_batch_{batch_num}.csv"

    print(f"\n==========================================")
    print(f"📦 Processing Batch {batch_num}")
    print(f"📄 CSV Order File: {csv_path}")

    if not csv_path.exists():
        print(f"❌ Error: CSV file not found: {csv_path}")
        return False

    # Read SKUs from CSV
    skus = []
    with open(csv_path, mode='r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            header = None
        for row in reader:
            if row:
                skus.append(row[0].strip())

    print(f"📋 Total SKUs loaded: {len(skus)}")

    # Special handling for Batch 5 (split folders set5-80 / set5-20) if present
    f80 = base_dir / f"set{batch_num}-80"
    f20 = base_dir / f"set{batch_num}-20"
    batch_folder = base_dir / f"batch {batch_num}"

    renamed_count = 0

    if f80.exists() and f20.exists():
        print(f"📂 Found split folders ({f80.name}, {f20.name}) -> Merging into {batch_folder.name}")
        batch_folder.mkdir(parents=True, exist_ok=True)
        
        def process_folder(folder_path: Path, skus_subset: list):
            nonlocal renamed_count
            files = [f for f in folder_path.iterdir() if f.is_file()]
            files.sort(key=lambda p: extract_num(p.name))
            for i, f in enumerate(files):
                if i < len(skus_subset):
                    sku = skus_subset[i]
                    safe_sku = sanitize_filename(sku)
                    ext = f.suffix
                    new_path = batch_folder / f"{safe_sku}{ext}"
                    try:
                        shutil.move(str(f), str(new_path))
                        renamed_count += 1
                    except Exception as e:
                        print(f"  ❌ Failed moving {f.name}: {e}")

        process_folder(f80, skus[:80])
        process_folder(f20, skus[80:])

    elif batch_folder.exists():
        print(f"📂 Processing folder: {batch_folder}")
        files = [f for f in batch_folder.iterdir() if f.is_file()]
        files.sort(key=lambda p: extract_num(p.name))
        
        if len(files) != len(skus):
            print(f"⚠️  Warning: Number of files ({len(files)}) != Number of SKUs ({len(skus)})")

        for i, f in enumerate(files):
            if i < len(skus):
                sku = skus[i]
                safe_sku = sanitize_filename(sku)
                ext = f.suffix
                new_path = batch_folder / f"{safe_sku}{ext}"
                if f != new_path:
                    try:
                        f.rename(new_path)
                        renamed_count += 1
                    except Exception as e:
                        print(f"  ❌ Failed renaming {f.name}: {e}")
    else:
        print(f"⚠️  Warning: Batch folder does not exist at {batch_folder}")
        return False

    print(f"✅ Batch {batch_num} completed: {renamed_count} files renamed/merged successfully.")
    return True


def main():
    parser = argparse.ArgumentParser(description="Rename product image files by batch based on SKU order CSV.")
    parser.add_argument("--batch", "-b", type=int, choices=range(1, 8), help="Batch number (1 to 7)")
    parser.add_argument("--all", "-a", action="store_true", help="Process all batches 1 through 7")
    parser.add_argument("--base-dir", "-d", type=str, help="Custom base image directory path")
    parser.add_argument("--csv", "-c", type=str, help="Custom order CSV file path")

    args = parser.parse_args()

    base_dir = Path(args.base_dir) if args.base_dir else None
    csv_path = Path(args.csv) if args.csv else None

    if args.all:
        for b in range(1, 8):
            process_batch(b, base_dir=base_dir)
    elif args.batch:
        process_batch(args.batch, base_dir=base_dir, csv_path=csv_path)
    else:
        print("ℹ️  No batch specified. Use --batch <1-7> or --all.")
        parser.print_help()


if __name__ == "__main__":
    main()
