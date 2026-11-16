"""Draw the app icon (a Pokeball) and write every size the app and installer need.

    python tools/make_icon.py

Drawn at 1024 px and shrunk with a high-quality filter, so small sizes stay clean. The design is
deliberately simple: at tray size (16-32 px) only the red/white halves and the dark band survive.
Outputs go to src-tauri/icons/: icon.png, 32x32.png, 128x128.png, 128x128@2x.png, icon.ico.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).resolve().parent.parent / 'src-tauri' / 'icons'
S = 1024                      # master canvas
RED, RED_DARK = (226, 49, 49), (168, 28, 36)
WHITE, WHITE_DARK = (247, 247, 244), (205, 205, 200)
INK = (34, 34, 40)


def ball() -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pad = 40
    box = (pad, pad, S - pad, S - pad)
    cx = cy = S // 2
    r = (S - 2 * pad) // 2

    # body: red upper half, white lower half, clipped to the circle
    body = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(body)
    d.rectangle((0, 0, S, cy), fill=RED)
    d.rectangle((0, cy, S, S), fill=WHITE)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    img.paste(body, (0, 0), mask)

    # soft shading: darker toward the lower-right rim, so it reads as a sphere
    shade = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    sd.ellipse((pad - r // 3, pad - r // 2, S - pad - r // 3, S - pad - r // 2), fill=(0, 0, 0, 0))
    ring = Image.new('L', (S, S), 0)
    rd = ImageDraw.Draw(ring)
    rd.ellipse(box, fill=70)
    rd.ellipse((pad + 70, pad + 50, S - pad - 20, S - pad - 60), fill=0)
    ring = ring.filter(ImageFilter.GaussianBlur(60))
    dark = Image.new('RGBA', (S, S), (20, 10, 20, 255))
    img.paste(dark, (0, 0), Image.composite(ring, Image.new('L', (S, S), 0), mask))

    # glossy highlight on the upper left of the red half
    gl = Image.new('L', (S, S), 0)
    ImageDraw.Draw(gl).ellipse((190, 150, 480, 330), fill=150)
    gl = gl.filter(ImageFilter.GaussianBlur(26))
    img.paste(Image.new('RGBA', (S, S), (255, 255, 255, 255)), (0, 0), Image.composite(gl, Image.new('L', (S, S), 0), mask))

    d = ImageDraw.Draw(img)
    band = 74
    d.rectangle((pad, cy - band // 2, S - pad, cy + band // 2), fill=INK)          # centre band
    # re-clip the band to the circle
    clip = Image.new('L', (S, S), 0)
    ImageDraw.Draw(clip).ellipse(box, fill=255)
    a = img.getchannel('A')
    img.putalpha(Image.composite(a, Image.new('L', (S, S), 0), clip))
    d = ImageDraw.Draw(img)
    d.ellipse(box, outline=INK, width=40)                                           # outer rim

    # centre button: dark ring, white face, small shine
    br = 150
    d.ellipse((cx - br, cy - br, cx + br, cy + br), fill=INK)
    d.ellipse((cx - br + 38, cy - br + 38, cx + br - 38, cy + br - 38), fill=WHITE)
    d.ellipse((cx - br + 38, cy - br + 38, cx + br - 38, cy + br - 38), outline=WHITE_DARK, width=10)
    d.ellipse((cx - 38, cy - 70, cx + 18, cy - 20), fill=(255, 255, 255, 255))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = ball()
    for name, px in [('icon.png', 512), ('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256)]:
        master.resize((px, px), Image.LANCZOS).save(OUT / name)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [master.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[-1].save(OUT / 'icon.ico', format='ICO', sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    pass
    print('wrote', ', '.join(sorted(p.name for p in OUT.iterdir())))


if __name__ == '__main__':
    main()
