import os
import shutil

dir80 = r'C:\Users\0125024\Pictures\image_product\set1-80'
dir20 = r'C:\Users\0125024\Pictures\image_product\set1-20'
dest = r'C:\Users\0125024\Pictures\image_product\batch 1'

os.makedirs(dest, exist_ok=True)

for i in range(1, 81):
    src = os.path.join(dir80, f'{i}.jpg')
    dst = os.path.join(dest, f'{i}.jpg')
    if os.path.exists(src):
        shutil.copy2(src, dst)

for i in range(1, 21):
    src = os.path.join(dir20, f'{i}.jpg')
    dst = os.path.join(dest, f'{i + 80}.jpg')
    if os.path.exists(src):
        shutil.copy2(src, dst)

print(f"Copied files to {dest}")
