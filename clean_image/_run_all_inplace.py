import os
from io import BytesIO
from PIL import Image, ImageFile
from rembg import remove, new_session

ImageFile.LOAD_TRUNCATED_IMAGES = True
SUPPORTED_EXT = (".png", ".jpg", ".jpeg", ".webp")
ROOT = r"W:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 25-06-69\รูปภาพอะไหล่ 25-06-69"
CANVAS = 800
PRODUCT = 500
QUALITY = 85
PROGRESS_EVERY = 20
ERROR_LOG = "_run_all_errors.txt"


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


def place_on_canvas(img_rgba, canvas_size, product_size):
    img = img_rgba.copy()
    img.thumbnail((product_size, product_size), Image.LANCZOS)
    canvas = Image.new("RGB", (canvas_size, canvas_size), (255, 255, 255))
    px = (canvas_size - img.width) // 2
    py = (canvas_size - img.height) // 2
    canvas.paste(img, (px, py), img.split()[3])
    return canvas


def process_one_inplace(path, session):
    src = open_image_any(path)
    no_bg = remove_bg_bytes(src, session)
    result = place_on_canvas(no_bg, CANVAS, PRODUCT)

    ext = os.path.splitext(path)[1].lower()
    temp_path = path + ".tmp"

    if ext in (".jpg", ".jpeg"):
        result.save(temp_path, "JPEG", quality=QUALITY, optimize=True)
    elif ext == ".png":
        result.save(temp_path, "PNG", optimize=True)
    elif ext == ".webp":
        result.save(temp_path, "WEBP", quality=QUALITY, method=6)
    else:
        result.save(temp_path, "JPEG", quality=QUALITY, optimize=True)

    os.replace(temp_path, path)


def main():
    files = list_images(ROOT)
    total = len(files)
    print(f"Total files: {total}")

    if total == 0:
        raise SystemExit("No image files found")

    session = new_session()
    ok = 0
    errors = []

    for idx, path in enumerate(files, start=1):
        try:
            process_one_inplace(path, session)
            ok += 1
        except Exception as exc:
            errors.append((path, str(exc)))

        if idx % PROGRESS_EVERY == 0 or idx == total:
            print(f"Progress: {idx}/{total} | OK: {ok} | ERR: {len(errors)}")

    with open(ERROR_LOG, "w", encoding="utf-8") as f:
        for path, err in errors:
            f.write(f"{path}\t{err}\n")

    print(f"Done: {ok}/{total}")
    print(f"Errors: {len(errors)}")
    print(f"Error log: {ERROR_LOG}")


if __name__ == "__main__":
    main()
