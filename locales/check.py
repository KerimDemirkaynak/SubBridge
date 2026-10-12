#!/usr/bin/env python3
"""Validates every locale file: same number of lines as keys.txt, placeholders preserved, nothing empty."""
import re, sys, pathlib
d = pathlib.Path(__file__).parent
keys = d.joinpath("keys.txt").read_text(encoding="utf-8").split()
en = d.joinpath("en.txt").read_text(encoding="utf-8").split("\n")
en = [l for l in en if l != ""] if len(en) != len(keys) else en
assert len(en) == len(keys), (len(en), len(keys))
ph = lambda s: sorted(re.findall(r"\{[a-z]+\}", s))
bad = 0
for f in sorted(d.glob("*.txt")):
    if f.name in ("keys.txt",): continue
    lines = f.read_text(encoding="utf-8").rstrip("\n").split("\n")
    problems = []
    if len(lines) != len(keys): problems.append(f"{len(lines)} lines, expected {len(keys)}")
    else:
        for i, (k, e, l) in enumerate(zip(keys, en, lines)):
            if not l.strip(): problems.append(f"{k} empty")
            if ph(e) != ph(l): problems.append(f"{k} placeholders {ph(l)} != {ph(e)}")
            if "\t" in l: problems.append(f"{k} has a tab")
    print(f"{f.stem:6}", "OK" if not problems else "PROBLEMS: " + "; ".join(problems[:6]))
    bad += bool(problems)
sys.exit(1 if bad else 0)
