#!/usr/bin/env python3
"""Converte pacotes .wastickers e imagens/vídeos em figurinhas válidas para o WhatsApp.

Uso:
    scripts/figurinhas.py ENTRADA [ENTRADA...] [-o SAIDA] [--titulo T] [--autor A]

ENTRADA pode ser um .wastickers, uma pasta ou arquivos de imagem/vídeo
(png, jpg, webp, gif, mp4, webm, mov).

Para cada figurinha gera em SAIDA:
  NN.webp  figurinha 512x512 (estática <= 100 KB, animada <= 500 KB e <= 10 s)
  NN.png   prévia do primeiro quadro
e um pacote SAIDA/<titulo>.wastickers pronto para importar.
"""
import argparse
import io
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from PIL import Image, ImageSequence

SIZE = 512
TRAY = 96
MAX_STATIC = 100 * 1024
MAX_ANIMATED = 500 * 1024
MAX_TRAY = 50 * 1024
MAX_SECONDS = 10
MIN_FRAME_MS = 8
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXT = {".mp4", ".webm", ".mov", ".mkv"}


def fit(frame: Image.Image, size: int) -> Image.Image:
    """Redimensiona mantendo a proporção e centraliza em um quadro transparente."""
    frame = frame.convert("RGBA")
    frame.thumbnail((size, size), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(frame, ((size - frame.width) // 2, (size - frame.height) // 2), frame)
    return canvas


def encode_static(img: Image.Image) -> bytes:
    for quality in range(95, 4, -10):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=quality, method=6)
        if buf.tell() <= MAX_STATIC:
            return buf.getvalue()
    raise ValueError("não coube em 100 KB")


def encode_animated(frames: list[Image.Image], durations: list[int]) -> bytes:
    # Corta em 10 s
    total, keep = 0, 0
    for d in durations:
        if total + d > MAX_SECONDS * 1000:
            break
        total += d
        keep += 1
    frames, durations = frames[: max(keep, 1)], durations[: max(keep, 1)]

    step = 1
    while True:
        sel = frames[::step]
        dur = [sum(durations[i : i + step]) for i in range(0, len(durations), step)]
        for quality in (80, 60, 40, 25, 10):
            buf = io.BytesIO()
            sel[0].save(buf, "WEBP", save_all=True, append_images=sel[1:], duration=dur,
                        loop=0, quality=quality, method=4, minimize_size=True)
            if buf.tell() <= MAX_ANIMATED:
                return buf.getvalue()
        if len(sel) <= 2:
            raise ValueError("não coube em 500 KB")
        step += 1  # descarta quadros e tenta de novo


def load_frames(path: Path) -> tuple[list[Image.Image], list[int]]:
    if path.suffix.lower() in VIDEO_EXT:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                ["ffmpeg", "-v", "error", "-i", str(path), "-t", str(MAX_SECONDS),
                 "-vf", "fps=15", "-an", f"{tmp}/%04d.png"],
                check=True,
            )
            frames = [fit(Image.open(p), SIZE) for p in sorted(Path(tmp).glob("*.png"))]
        return frames, [1000 // 15] * len(frames)
    im = Image.open(path)
    frames, durations = [], []
    for frame in ImageSequence.Iterator(im):
        frames.append(fit(frame, SIZE))
        durations.append(max(frame.info.get("duration", im.info.get("duration", 100)) or 100,
                             MIN_FRAME_MS))
    return frames, durations


def convert(path: Path) -> tuple[bytes, Image.Image, bool]:
    frames, durations = load_frames(path)
    if len(frames) > 1:
        return encode_animated(frames, durations), frames[0], True
    return encode_static(frames[0]), frames[0], False


def make_tray(img: Image.Image) -> bytes:
    tray = fit(img, TRAY)
    for colors in (None, 128, 64, 32):
        buf = io.BytesIO()
        (tray if colors is None else tray.quantize(colors)).save(buf, "PNG", optimize=True)
        if buf.tell() <= MAX_TRAY:
            return buf.getvalue()
    return buf.getvalue()


def collect(inputs: list[Path], work: Path) -> tuple[list[Path], dict]:
    files, meta = [], {}
    for item in inputs:
        if item.suffix.lower() == ".wastickers":
            dest = work / item.stem
            with zipfile.ZipFile(item) as z:
                for name in z.namelist():
                    target = (dest / name).resolve()
                    if not target.is_relative_to(dest.resolve()):
                        raise ValueError(f"caminho inválido no pacote: {name}")
                z.extractall(dest)
            for key, fname in (("titulo", "title.txt"), ("autor", "author.txt")):
                if (dest / fname).exists():
                    meta.setdefault(key, (dest / fname).read_text(errors="replace").strip())
            if (dest / "tray.png").exists():
                meta.setdefault("tray", dest / "tray.png")
            files += sorted(p for p in dest.iterdir() if p.suffix.lower() == ".webp")
        elif item.is_dir():
            files += sorted(p for p in item.iterdir() if p.suffix.lower() in IMAGE_EXT | VIDEO_EXT)
        else:
            files.append(item)
    return files, meta


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("entradas", nargs="+", type=Path)
    ap.add_argument("-o", "--saida", type=Path, default=Path("figurinhas"))
    ap.add_argument("--titulo")
    ap.add_argument("--autor")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        files, meta = collect(args.entradas, Path(tmp))
        if not files:
            print("nenhuma figurinha encontrada", file=sys.stderr)
            return 1
        titulo = args.titulo or meta.get("titulo") or "Figurinhas"
        autor = args.autor or meta.get("autor") or "Fig"
        args.saida.mkdir(parents=True, exist_ok=True)

        stickers, first = [], None
        for i, path in enumerate(files, 1):
            try:
                data, preview, animated = convert(path)
            except Exception as exc:  # segue com as demais
                print(f"[erro] {path.name}: {exc}", file=sys.stderr)
                continue
            name = f"{i:02d}.webp"
            (args.saida / name).write_bytes(data)
            preview.save(args.saida / f"{i:02d}.png")
            stickers.append((name, data))
            first = first or preview
            kind = "animada" if animated else "estática"
            print(f"{name}  {kind:8}  {len(data) / 1024:6.1f} KB  <- {path.name}")

        if not stickers:
            return 1
        tray = meta["tray"].read_bytes() if "tray" in meta else make_tray(first)
        if len(tray) > MAX_TRAY or Image.open(io.BytesIO(tray)).size != (TRAY, TRAY):
            tray = make_tray(Image.open(io.BytesIO(tray)))

        pack = args.saida / f"{titulo}.wastickers"
        with zipfile.ZipFile(pack, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("title.txt", titulo)
            z.writestr("author.txt", autor)
            z.writestr("tray.png", tray)
            for name, data in stickers:
                z.writestr(name, data)
        print(f"pacote: {pack}")
        if len(stickers) < 3:
            print("aviso: o WhatsApp exige de 3 a 30 figurinhas por pacote importado; "
                  "junte mais figurinhas ou envie a(s) imagem(ns) individualmente.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
