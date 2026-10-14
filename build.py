#!/usr/bin/env python3
"""Builds dist/chrome and dist/firefox (+ .zip) from src/ and manifest.base.json."""
import json, shutil, subprocess, sys, zipfile, pathlib

root = pathlib.Path(__file__).parent
subprocess.run([sys.executable, str(root / "locales/check.py")], check=True, stdout=subprocess.DEVNULL)   # fail the build on a bad locale file
subprocess.run([sys.executable, str(root / "gen_i18n.py")], check=True)
src, dist = root / "src", root / "dist"
base = json.loads((root / "manifest.base.json").read_text())

targets = {
    "chrome": {"background": {"service_worker": "background.js"}},
    "firefox": {
        "background": {"scripts": ["scripts.js", "providers.js", "background.js"]},
        "browser_specific_settings": {"gecko": {
            "id": "subtitle-player-translator@example.com",   # CHANGE to your own id
            "strict_min_version": "142.0",
            # Subtitle text is sent to the translation engine the user picks:
            "data_collection_permissions": {"required": ["websiteContent"]},
        }},
    },
}

if dist.exists():
    shutil.rmtree(dist)
for name, extra in targets.items():
    out = dist / name
    shutil.copytree(src, out)
    manifest = {**base, **extra}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    zpath = dist / (f"subbridge-{name}.zip" if name == "chrome" else f"subbridge-{name}.xpi")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out).as_posix())
    print("built", zpath.name, zpath.stat().st_size, "bytes")
