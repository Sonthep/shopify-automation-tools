import os
from io import BytesIO
from PIL import Image, ImageFile
from rembg import remove, new_session

ImageFile.LOAD_TRUNCATED_IMAGES = True
SUPPORTED_EXT = ('.png', '.jpg', '.jpeg', '.webp')
ROOT = r'.\\รวมสินค้า'
CANVAS = 800
PRODUCT = 500
QUALITY = 85
LIMIT = 3


def list_images(folder):
    files = []
    for root, _, names in os.walk(folder):
        for n in names:
            if n.lower().endswith(SUPPORTED_EXT):
                files.append(os.path.join(root, n))
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
    b = BytesIO()
    img_rgba.save(b, format='PNG')
    out = remove(b.getvalue(), session=session)
    return Image.open(BytesIO(out)).convert('RGBA')

def place_on_canvas(img_rgba, canvas_size, product_size):
    img = img_rgba.copy()
    img.thumbnail((product_size, product_size), Image.LANCZOS)
    canvas = Image.new('RGB', (canvas_size, canvas_size), (255, 255, 255))
    px = (canvas_size - img.width) // 2
    py = (canvas_size - img.height) // 2
    canvas.paste(img, (px, py), img.split()[3])
    return canvas

def process_one_inplace(path, session):
    src = open_image_any(path)
    no_bg = remove_bg_bytes(src, session)
    result = place_on_canvas(no_bg, CANVAS, PRODUCT)
    ext = os.path.splitext(path)[1].lower()
    temp_path = path + '.tmp'
    if ext in ('.jpg', '.jpeg'):
        result.save(temp_path, 'JPEG', quality=QUALITY, optimize=True)
    elif ext == '.png':
        result.save(temp_path, 'PNG', optimize=True)
    elif ext == '.webp':
        result.save(temp_path, 'WEBP', quality=QUALITY, method=6)
    else:
        result.save(temp_path, 'JPEG', quality=QUALITY, optimize=True)
    os.replace(temp_path, path)

files = list_images(ROOT)[:LIMIT]
print(f'Trial files: {len(files)}')
for f in files:
    print(f' - {f}')

if not files:
    raise SystemExit('No image files found for trial')

session = new_session()
ok = 0
for f in files:
    try:
        process_one_inplace(f, session)
        ok += 1
        print(f'OK  {f}')
    except Exception as e:
        print(f'ERR {f} | {e}')

print(f'Done: {ok}/{len(files)}')
