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

# Scenario D: one-sample fluke. White (dr) talks, black (host) pops up with a
# faint but dominant face for a single sample (detection dropout on white) —
# the anchor must not jump to him. Only sustained dominance (>=2 samples) may
# switch.
samples4 = [
    {"t": 0.0, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 0.0)], "cut": 0.0},
    {"t": 0.7, "faces": [face(0.19, 6400, 2.8), face(0.81, 5290, 0.0)], "cut": 0.0},
    {"t": 1.4, "faces": [face(0.19, 6400, 3.0), face(0.81, 5290, 0.0)], "cut": 0.0},
    {"t": 2.1, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 1.8)], "cut": 0.0},  # white failed
    {"t": 2.8, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 0.0)], "cut": 0.0},
    {"t": 3.5, "faces": [face(0.19, 6400, 2.9), face(0.81, 5290, 0.0)], "cut": 0.0},
    {"t": 4.2, "faces": [face(0.19, 6400, 3.1), face(0.81, 5290, 0.0)], "cut": 0.0},
]
out4 = pick_anchors(samples4, [(0.4, 4.5)])
xs4 = [cx for (t, cx, n) in out4 if 2.0 <= t <= 3.0]
assert xs4 and all(abs(cx - 0.19) < 0.05 for cx in xs4), out4

# Scenario E: two sustained samples of the second face DO switch the anchor.
samples5 = samples4[:3] + [
    {"t": 2.1, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 4.0)], "cut": 0.0},
    {"t": 2.8, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 3.8)], "cut": 0.0},
    {"t": 3.5, "faces": [face(0.19, 6400, 0.0), face(0.81, 5290, 3.9)], "cut": 0.0},
]
out5 = pick_anchors(samples5, [(0.4, 4.5)])
xs5 = [cx for (t, cx, n) in out5 if t >= 2.8]
assert xs5 and all(abs(cx - 0.81) < 0.05 for cx in xs5), out5

# Scenario F: anticipatory pre-positioning. A speaks (2.0-4.5), a silence gap
# follows, B starts his turn at 5.5. In the 0.9s before 5.5 B's mouth is
# already opening — the camera must move to him BEFORE the words start, not
# hold on A and whip over only when speech is detected.
samples6 = [
    {"t": 0.0, "faces": [face(0.25, 6400, 0.0), face(0.70, 8100, 0.0)], "cut": 0.0},
    {"t": 0.7, "faces": [face(0.25, 6400, 3.0), face(0.70, 8100, 0.2)], "cut": 0.0},
    {"t": 1.4, "faces": [face(0.25, 6400, 3.2), face(0.70, 8100, 0.2)], "cut": 0.0},
    {"t": 2.1, "faces": [face(0.25, 6400, 3.1), face(0.70, 8100, 0.3)], "cut": 0.0},
    {"t": 2.8, "faces": [face(0.25, 6400, 3.0), face(0.70, 8100, 0.2)], "cut": 0.0},
    {"t": 4.3, "faces": [face(0.25, 6400, 0.4), face(0.70, 8100, 0.3)], "cut": 0.0},  # silence
    {"t": 5.0, "faces": [face(0.25, 6400, 0.4), face(0.70, 8100, 1.6)], "cut": 0.0},  # pre-speech: B inhales
    {"t": 5.7, "faces": [face(0.25, 6400, 0.2), face(0.70, 8100, 2.2)], "cut": 0.0},  # words start
    {"t": 6.4, "faces": [face(0.25, 6400, 0.2), face(0.70, 8100, 2.8)], "cut": 0.0},
]
out6 = pick_anchors(samples6, [(0.4, 4.5), (5.5, 8.0)])
pre = [cx for (t, cx, n) in out6 if t == 5.0]
assert pre and abs(pre[0] - 0.70) < 0.05, out6  # already on B before his line
xs6 = [cx for (t, cx, n) in out6 if t >= 5.7]
assert xs6 and all(abs(cx - 0.70) < 0.05 for cx in xs6), out6
hold = [cx for (t, cx, n) in out6 if t == 4.3]
assert hold and abs(hold[0] - 0.25) < 0.05, out6  # mid-gap still holds A

# Scenario G: a silent face during pre-speech must NOT grab the anchor.
samples7 = [
    {"t": 0.0, "faces": [face(0.25, 6400, 3.0), face(0.70, 8100, 0.0)], "cut": 0.0},
    {"t": 0.7, "faces": [face(0.25, 6400, 3.1), face(0.70, 8100, 0.0)], "cut": 0.0},
    {"t": 1.4, "faces": [face(0.25, 6400, 3.0), face(0.70, 8100, 0.2)], "cut": 0.0},
    {"t": 2.1, "faces": [face(0.25, 6400, 0.3), face(0.70, 8100, 0.0)], "cut": 0.0},  # gap, B quiet
    {"t": 2.8, "faces": [face(0.25, 6400, 2.8), face(0.70, 8100, 2.5)], "cut": 0.0},  # both mid-motion
]
out7 = pick_anchors(samples7, [(0.4, 2.6), (2.9, 5.0)])
early = [cx for (t, cx, n) in out7 if t == 2.1]
assert early and abs(early[0] - 0.25) < 0.05, out7

print("track_faces speech-gating self-check: OK")
