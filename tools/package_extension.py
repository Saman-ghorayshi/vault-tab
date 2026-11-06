import os
import zipfile
import json

base_dir = r"C:\Users\Samsha\Documents\tabsaver"
dist_dir = os.path.join(base_dir, "dist")
os.makedirs(dist_dir, exist_ok=True)

manifest_path = os.path.join(base_dir, "manifest.json")
with open(manifest_path, "r", encoding="utf-8") as f:
    manifest = json.load(f)

version = manifest.get("version", "2.4.0")
zip_filename = f"vaulttab-v{version}.zip"
zip_path = os.path.join(dist_dir, zip_filename)

included_dirs = ["common", "icons", "manager_page", "popup"]
included_files = ["manifest.json", "background.js", "LICENSE"]

print(f"Packaging VaultTab v{version} into {zip_filename}...")

with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    # Add root files
    for file in included_files:
        src = os.path.join(base_dir, file)
        if os.path.exists(src):
            zf.write(src, arcname=file)
            print(f"  + {file}")

    # Add directories recursively
    for dir_name in included_dirs:
        dir_path = os.path.join(base_dir, dir_name)
        if os.path.exists(dir_path):
            for root, dirs, files in os.walk(dir_path):
                for file in files:
                    # Skip system / temp files
                    if file.startswith(".") or file.endswith(".tmp"):
                        continue
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, base_dir)
                    zf.write(full_path, arcname=rel_path)
                    print(f"  + {rel_path}")

zip_size_kb = os.path.getsize(zip_path) / 1024
print(f"\nSUCCESS: Created clean production package at {zip_path} ({zip_size_kb:.1f} KB)")
