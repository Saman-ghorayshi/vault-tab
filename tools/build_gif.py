import os
import subprocess
import time
from PIL import Image

edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
base_dir = r"C:\Users\Samsha\Documents\tabsaver"
tools_dir = os.path.join(base_dir, "tools")
assets_dir = os.path.join(base_dir, "assets")
html_path = os.path.join(tools_dir, "render_simulator.html")

frames_dir = os.path.join(tools_dir, "frames")
os.makedirs(frames_dir, exist_ok=True)
os.makedirs(assets_dir, exist_ok=True)

# 11-step realistic workflow sequence
sequence = [
    ("1", 1200, "01_cluttered_tabs_high_ram.png"),
    ("1b", 700, "02_hover_extension_icon.png"),
    ("2", 1400, "03_popup_open_encrypt_cta.png"),
    ("3a", 900, "04_pbkdf2_key_derivation.png"),
    ("3b", 1400, "05_aes_gcm_stashed_toast.png"),
    ("4", 1600, "06_manager_ram_freed.png"),
    ("5a", 800, "07_search_typing_liquidity.png"),
    ("5b", 2200, "08_semantic_vector_matches.png"),
    ("6a", 1000, "09_webauthn_touch_prompt.png"),
    ("6b", 1400, "10_webauthn_hardware_verified.png"),
    ("7", 2200, "11_tabs_restored_active.png"),
]

captured_images = []
durations = []

print("Rendering high-fidelity screencast frames...")
for step, duration, filename in sequence:
    out_file = os.path.join(frames_dir, filename)
    url = f"file:///{html_path.replace(os.sep, '/')}?step={step}"
    cmd = [
        edge,
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=960,580",
        f"--screenshot={out_file}",
        url
    ]
    subprocess.run(cmd, check=True)
    print(f"  ✓ Frame {filename} (step={step})")
    
    img = Image.open(out_file).convert("RGBA")
    # Composite over dark canvas
    bg = Image.new("RGB", img.size, (3, 6, 11))
    bg.paste(img, mask=img.split()[3])
    quantized = bg.quantize(colors=256, method=Image.Resampling.LANCZOS)
    captured_images.append(quantized)
    durations.append(duration)

# Also update the static manager & demo preview assets with these high quality renders
Image.open(os.path.join(frames_dir, "08_semantic_vector_matches.png")).save(os.path.join(assets_dir, "vaulttab-manager-ui.png"))
Image.open(os.path.join(frames_dir, "05_aes_gcm_stashed_toast.png")).save(os.path.join(assets_dir, "vaulttab-live-demo.png"))

# Save animated GIF
gif_path = os.path.join(assets_dir, "vaulttab-demo.gif")
captured_images[0].save(
    gif_path,
    save_all=True,
    append_images=captured_images[1:],
    duration=durations,
    loop=0,
    optimize=True
)

gif_size_kb = os.path.getsize(gif_path) / 1024
print(f"SUCCESS: Saved studio animated screencast GIF to {gif_path} ({gif_size_kb:.1f} KB)")
