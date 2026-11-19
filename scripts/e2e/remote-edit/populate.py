"""Lays out the scratch project the scenario edits: three video clips, a music bed, six captions."""
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORK = os.environ["RF_E2E_WORK"]
CLI = ["node", os.path.join(ROOT, "packages/cli/bin/reelforge.js")]
pid = open(f"{WORK}/project").read().strip()

tl = json.loads(subprocess.check_output(CLI + ["timeline", "get", pid]))["timeline"]
by = {a["filename"]: a["id"] for a in tl["assets"]}
tr = {t["kind"] + ":" + t["name"]: t["id"] for t in tl["tracks"]}
V, MUSIC, C = tr["video:Video"], tr["audio:Music"], tr["caption:Captions"]
ops = [
    {"type": "clip.add", "trackId": V, "assetId": by["C001_Espresso.mp4"], "start": 0, "duration": 150},
    {"type": "clip.add", "trackId": V, "assetId": by["wide.mp4"], "start": 150, "sourceIn": 96, "duration": 558 - 96},
    {"type": "clip.add", "trackId": V, "assetId": by["C004_Beans.mp4"], "start": 612, "duration": 180},
    {"type": "clip.add", "trackId": MUSIC, "assetId": by["Cafe_Mood.wav"], "start": 0, "duration": 792, "props": {"gainDb": -12}},
]
caps = [
    (0, 90, "Welcome back to the channel."),
    (100, 200, "Today: one trading setup."),
    (312, 114, "The spider trade strategy, explained."),
    (430, 120, "What is a spider trade?"),
    (560, 110, "Three legs, one risk."),
    (680, 100, "Follow for part two."),
]
ops.append({"type": "captions.replace", "trackId": C, "captions": [{"start": s, "duration": d, "text": t} for s, d, t in caps]})
ops.append({"type": "track.update", "trackId": C, "captionStyle": {"font": "Poppins SemiBold", "size": 0.038, "highlight": None, "stroke": 0.06, "y": 0.8}})
subprocess.run(CLI + ["timeline", "apply", pid, "--ops", json.dumps(ops), "--base-revision", str(tl["project"]["revision"])], check=True, stdout=subprocess.DEVNULL)
