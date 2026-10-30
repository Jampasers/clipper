#!/usr/bin/env python
"""Self-check for speech-gated speaker selection in track_faces.py.

Scenario A: two-shot interview, B is closer/bigger and static, A is the
soft-spoken talker (mouth motion below the old absolute talk floor).
The tracker must follow A while the transcript says someone is speaking,
and must not jump to B when B bobs their head during silence.

Scenario B: camera cuts to a second speaker (single visible face) while that
speaker's transcript segment is active; the tracker must take the new face
even though its mouth motion never clears the old floor.

Scenario C: no transcript windows (music, no speech) keeps the legacy
largest-face behavior.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_faces import pick_anchors


def face(cx, area=6400, talk=0.0):
    return {"cx": cx, "area": area, "talk": talk}


samples = [
    {"t": 0.0, "faces": [face(0.25, 6400, 0.0), face(0.70, 8100, 0.0)], "cut": 0.0},
    {"t": 1.9, "faces": [face(0.25, 6400, 0.2), face(0.70, 8100, 0.1)], "cut": 0.0},
    {"t": 2.6, "faces": [face(0.25, 6400, 3.0), face(0.70, 8100, 0.2)], "cut": 0.0},
    {"t": 3.3, "faces": [face(0.25, 6400, 3.4), face(0.70, 8100, 0.3)], "cut": 0.0},
    {"t": 4.0, "faces": [face(0.25, 6400, 2.8), face(0.70, 8100, 0.4)], "cut": 0.0},
    {"t": 6.5, "faces": [face(0.25, 6400, 0.5), face(0.70, 8100, 9.0)], "cut": 0.0},
    {"t": 7.2, "faces": [face(0.25, 6400, 0.1), face(0.70, 8100, 0.0)], "cut": 0.0},
]
speech = [(2.0, 4.5)]
out = pick_anchors(samples, speech)
assert out and out[0][0] >= 1.6, out
mid = [cx for (t, cx, n) in out if 2.0 <= t <= 4.0]
assert mid and all(abs(cx - 0.25) < 0.05 for cx in mid), mid
late = [cx for (t, cx, n) in out if t >= 6.5 and n > 0]
assert late and all(abs(cx - 0.25) < 0.05 for cx in late), late

samples2 = [
    {"t": 0.0, "faces": [face(0.25)], "cut": 0.0},
    {"t": 0.7, "faces": [face(0.25)], "cut": 0.0},
    {"t": 4.0, "faces": [face(0.80, 6400, 2.5)], "cut": 1.0},
    {"t": 4.7, "faces": [face(0.80, 6400, 2.0)], "cut": 0.0},
]
out2 = pick_anchors(samples2, [(3.8, 6.0)])
tail = [cx for (t, cx, n) in out2 if t >= 4.0 and n == 1]
assert tail and all(abs(cx - 0.80) < 0.05 for cx in tail), out2

out3 = pick_anchors(samples, [])
assert out3 and abs(out3[0][1] - 0.70) < 1e-9, out3

print("track_faces speech-gating self-check: OK")
