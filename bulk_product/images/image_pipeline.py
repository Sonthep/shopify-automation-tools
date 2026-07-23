
import os
from io import BytesIO
from PIL import Image, ImageFile
from rembg import remove, new_session
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

# ===== Safety for partially downloaded / large images =====
ImageFile.LOAD_TRUNCATED_IMAGES = True

SUPPORTED_EXT = ('.png', '.jpg', '.jpeg', '.webp')

def list_images(folder):
    files = []
    for root, _, filenames in os.walk(folder):
        for f in filenames:
            if f.lower().endswith(SUPPORTED_EXT):
                files.append(os.path.join(root, f))
    return files

def open_image_any(path):
    """เปิดรูปและแปลงเป็น RGBA อย่างปลอดภัย"""
    img = Image.open(path)
    # บางไฟล์มี ICC/โหมดสีแปลก: แปลงเป็น RGBA ให้เสมอ
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    else:
        img = img.copy()
        if img.mode == "RGB":
            img = img.convert("RGBA")
    return img

def remove_bg_bytes(img_rgba):
    """ลบพื้นหลังด้วย rembg (ใช้ session เดียวทั้งงานเพื่อความเร็ว)"""
    img_bytes = BytesIO()
    img_rgba.save(img_bytes, format="PNG")
    out = remove(img_bytes.getvalue(), session=SESSION)
    return Image.open(BytesIO(out)).convert("RGBA")

def place_on_canvas(img_rgba, canvas_size, product_size, bg_color=(255, 255, 255)):
    """ย่อภาพ (longest side = product_size) แล้ววางกึ่งกลางบน canvas สี่เหลี่ยม"""
    # ย่อโดยรักษาสัดส่วน
    img = img_rgba.copy()
    img.thumbnail((product_size, product_size), Image.LANCZOS)

    canvas = Image.new("RGB", (canvas_size, canvas_size), bg_color)
    px = (canvas_size - img.width) // 2
    py = (canvas_size - img.height) // 2
    canvas.paste(img, (px, py), img.split()[3])  # ใช้ alpha เป็น mask
    return canvas

def process_one_inplace(input_path, canvas_size, product_size, jpg_quality=85):
    """ประมวลผลทีละไฟล์และบันทึกทับไฟล์เดิมอย่างปลอดภัย"""
    src = open_image_any(input_path)
    no_bg = remove_bg_bytes(src)
    result = place_on_canvas(no_bg, canvas_size, product_size)

    ext = os.path.splitext(input_path)[1].lower()
    temp_path = input_path + ".tmp"

    if ext in (".jpg", ".jpeg"):
        result.save(temp_path, "JPEG", quality=jpg_quality, optimize=True)
    elif ext == ".png":
        result.save(temp_path, "PNG", optimize=True)
    elif ext == ".webp":
        result.save(temp_path, "WEBP", quality=jpg_quality, method=6)
    else:
        result.save(temp_path, "JPEG", quality=jpg_quality, optimize=True)

    os.replace(temp_path, input_path)

def run_pipeline(src_folder, canvas_size, product_size, log_widget, progressbar, lbl_status):
    files = list_images(src_folder)
    total = len(files)
    if total == 0:
        messagebox.showwarning("ไม่พบไฟล์", "ไม่พบรูปภาพในโฟลเดอร์ต้นทาง")
        return

    progressbar["maximum"] = total
    done = 0
    errors = 0

    for in_path in files:
        try:
            process_one_inplace(in_path, canvas_size, product_size)
            msg = f"✅ {os.path.relpath(in_path, src_folder)}"
        except Exception as e:
            errors += 1
            msg = f"❌ {os.path.relpath(in_path, src_folder)} | {e}"

        # update UI
        done += 1
        progressbar["value"] = done
        lbl_status.config(text=f"กำลังประมวลผล {done}/{total} ไฟล์")
        log_widget.insert(tk.END, msg + "\n")
        log_widget.see(tk.END)
        root.update_idletasks()

    summary = f"🎉 เสร็จสิ้น: {done - errors}/{total} ไฟล์สำเร็จ, ผิดพลาด {errors} ไฟล์\n\nโฟลเดอร์ที่ทำงาน:\n{src_folder}\n(บันทึกทับไฟล์เดิมทั้งหมด)"
    messagebox.showinfo("สรุปผล", summary)

# ========================= GUI =========================
root = tk.Tk()
root.title("BG Remover → 800x800 Canvas (with Progress)")
root.geometry("700x460")

# เลือกโฟลเดอร์ต้นทาง
frm_sel = tk.Frame(root)
frm_sel.pack(fill="x", padx=12, pady=(12, 6))

src_var = tk.StringVar(value=r"U:\25.WEBSITE\Sp_Website\รูปภาพอะไหล่ 09-07-69\รูปภาพอะไหล่ 09-07-69")

def pick_src():
    p = filedialog.askdirectory(title="📂 เลือกโฟลเดอร์ต้นทาง")
    if p:
        src_var.set(p)

tk.Label(frm_sel, text="โฟลเดอร์ต้นทาง:").grid(row=0, column=0, sticky="w")
tk.Entry(frm_sel, textvariable=src_var, width=70).grid(row=0, column=1, padx=6)
tk.Button(frm_sel, text="เลือก...", command=pick_src).grid(row=0, column=2)

# ตั้งค่า Canvas/Product size
frm_cfg = tk.Frame(root)
frm_cfg.pack(fill="x", padx=12, pady=6)

canvas_var = tk.IntVar(value=800)
product_var = tk.IntVar(value=500)
quality_var = tk.IntVar(value=85)

tk.Label(frm_cfg, text="Canvas (px):").grid(row=0, column=0, sticky="w")
tk.Entry(frm_cfg, textvariable=canvas_var, width=8).grid(row=0, column=1, padx=(6,18))

tk.Label(frm_cfg, text="Product (px):").grid(row=0, column=2, sticky="w")
tk.Entry(frm_cfg, textvariable=product_var, width=8).grid(row=0, column=3, padx=(6,18))

tk.Label(frm_cfg, text="JPEG quality:").grid(row=0, column=4, sticky="w")
tk.Entry(frm_cfg, textvariable=quality_var, width=6).grid(row=0, column=5, padx=(6,18))

# Log + Progress
frm_prog = tk.Frame(root)
frm_prog.pack(fill="both", expand=True, padx=12, pady=6)

log = tk.Text(frm_prog, height=14)
log.pack(fill="both", expand=True)

status = tk.Label(root, text="พร้อมเริ่มทำงาน", anchor="w")
status.pack(fill="x", padx=12)

pb = ttk.Progressbar(root, mode="determinate")
pb.pack(fill="x", padx=12, pady=(2,12))

# ปุ่มเริ่ม
def start():
    src = src_var.get().strip()
    if not src or not os.path.isdir(src):
        messagebox.showerror("Error", "กรุณาเลือกโฟลเดอร์ต้นทางที่ถูกต้อง")
        return
    if not messagebox.askyesno("ยืนยัน", "สคริปต์จะประมวลผลทุก sub folder และบันทึกทับไฟล์เดิมทั้งหมด\nต้องการดำเนินการต่อหรือไม่?"):
        return
    try:
        csize = int(canvas_var.get())
        psize = int(product_var.get())
        q = int(quality_var.get())
    except:
        messagebox.showerror("Error", "ค่าที่กรอกต้องเป็นตัวเลข")
        return
    if psize > csize:
        if not messagebox.askyesno("ยืนยัน", "ขนาด Product ใหญ่กว่า Canvas — ต้องการดำเนินการต่อหรือไม่?"):
            return
    run_pipeline(src, csize, psize, log, pb, status)

btn = tk.Button(root, text="▶ เริ่มประมวลผล", command=start)
btn.pack(pady=(0,10))

# ===== สร้าง rembg session เพียงครั้งเดียว =====
try:
    SESSION = new_session()  # ใช้โมเดลดีฟอลต์ของ rembg
except Exception as e:
    messagebox.showerror("rembg error", f"ไม่สามารถสร้าง session ได้\n{e}")
    root.destroy()
    raise SystemExit

root.mainloop()

