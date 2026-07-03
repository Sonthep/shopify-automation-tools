import os
import shutil

base_dir = r'C:\Users\0125024\Pictures\image_product'
out_folder = os.path.join(base_dir, 'merged_all_batches')

if not os.path.exists(out_folder):
    os.makedirs(out_folder)

copied_count = 0

# Loop through batch 1 to 7
for i in range(1, 8):
    batch_folder = os.path.join(base_dir, f'batch {i}')
    if os.path.exists(batch_folder):
        files = [f for f in os.listdir(batch_folder) if os.path.isfile(os.path.join(batch_folder, f))]
        for f in files:
            src = os.path.join(batch_folder, f)
            dst = os.path.join(out_folder, f)
            try:
                shutil.copy2(src, dst)
                copied_count += 1
            except Exception as e:
                print(f"Failed to copy {f}: {e}")

print(f"Successfully copied and merged {copied_count} files into {out_folder}")
