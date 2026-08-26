import os
import sys
import time
import argparse
from io import BytesIO

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from PIL import Image, ImageFile
from rembg import remove, new_session

ImageFile.LOAD_TRUNCATED_IMAGES = True
SUPPORTED_EXT = (".png", ".jpg", ".jpeg", ".webp")

DEFAULT_CANVAS = 800
DEFAULT_PRODUCT = 500
DEFAULT_QUALITY = 85


def list_images(folder):
    files = []
    for root, _, names in os.walk(folder):
        for name in names:
            if name.lower().endswith(SUPPORTED_EXT):
                files.append(os.path.join(root, name))
    files.sort()
    return files


def open_image_any(path):
    img = Image.open(path)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    else:
        img = img.copy()
        if img.mode == "RGB":
            img = img.convert("RGBA")
    return img


def remove_bg_bytes(img_rgba, session):
    buf = BytesIO()
    img_rgba.save(buf, format="PNG")
    out = remove(buf.getvalue(), session=session)
    return Image.open(BytesIO(out)).convert("RGBA")


def place_on_canvas(img_rgba, canvas_size=DEFAULT_CANVAS, product_size=DEFAULT_PRODUCT):
    img = img_rgba.copy()
    img.thumbnail((product_size, product_size), Image.LANCZOS)
    canvas = Image.new("RGB", (canvas_size, canvas_size), (255, 255, 255))
    px = (canvas_size - img.width) // 2
    py = (canvas_size - img.height) // 2
    canvas.paste(img, (px, py), img.split()[3])
    return canvas


def process_one_inplace(path, session, canvas_size=DEFAULT_CANVAS, product_size=DEFAULT_PRODUCT, quality=DEFAULT_QUALITY):
    src = open_image_any(path)
    no_bg = remove_bg_bytes(src, session)
    result = place_on_canvas(no_bg, canvas_size, product_size)

    ext = os.path.splitext(path)[1].lower()
    temp_path = path + ".tmp"

    if ext in (".jpg", ".jpeg"):
        result.save(temp_path, "JPEG", quality=quality, optimize=True)
    elif ext == ".png":
        result.save(temp_path, "PNG", optimize=True)
    elif ext == ".webp":
        result.save(temp_path, "WEBP", quality=quality, method=6)
    else:
        result.save(temp_path, "JPEG", quality=quality, optimize=True)

    os.replace(temp_path, path)


def clean_images(target_dir, canvas_size=DEFAULT_CANVAS, product_size=DEFAULT_PRODUCT, quality=DEFAULT_QUALITY, workers=1):
    if not os.path.isdir(target_dir):
        print(f"❌ Error: Folder not found -> {target_dir}")
        return False

    files = list_images(target_dir)
    total = len(files)
    print(f"📁 Target Folder : {target_dir}")
    print(f"🖼️ Found images  : {total}")
    print(f"📐 Canvas Size   : {canvas_size}x{canvas_size} (Product: {product_size}px, Quality: {quality})")
    print("-" * 60)

    if total == 0:
        print("⚠️ No images found to process.")
        return False

    print("🚀 Initializing rembg session...")
    session = new_session()

    start_time = time.time()
    ok_count = 0
    errors = []

    for idx, path in enumerate(files, start=1):
        rel_path = os.path.relpath(path, target_dir)
        t0 = time.time()
        try:
            process_one_inplace(path, session, canvas_size, product_size, quality)
            elapsed = time.time() - t0
            ok_count += 1
            print(f"[{idx:3d}/{total}] ✅ {rel_path} ({elapsed:.2f}s)")
        except Exception as exc:
            elapsed = time.time() - t0
            errors.append((path, str(exc)))
            print(f"[{idx:3d}/{total}] ❌ {rel_path} | Error: {exc}")

    total_time = time.time() - start_time
    print("-" * 60)
    print(f"✨ Done in {total_time:.1f}s | Success: {ok_count}/{total} | Failed: {len(errors)}")

    if errors:
        error_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "clean_errors.log")
        with open(error_file, "w", encoding="utf-8") as f:
            for p, err in errors:
                f.write(f"{p}\t{err}\n")
        print(f"⚠️ Error log saved to: {error_file}")

    return len(errors) == 0


def main():
    parser = argparse.ArgumentParser(description="Clean and standardize product images for Shopify web upload")
    parser.add_argument("--path", "-p", type=str, default=r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ PRIMO 4-2026\รูปภาพอะไหล่", help="Target directory path")
    parser.add_argument("--canvas", "-c", type=int, default=DEFAULT_CANVAS, help="Canvas size in pixels (default: 800)")
    parser.add_argument("--product", type=int, default=DEFAULT_PRODUCT, help="Product max dimension in pixels (default: 500)")
    parser.add_argument("--quality", "-q", type=int, default=DEFAULT_QUALITY, help="JPEG quality (default: 85)")

    args = parser.parse_args()
    clean_images(args.path, canvas_size=args.canvas, product_size=args.product, quality=args.quality)


if __name__ == "__main__":
    main()
