#!/usr/bin/env python
"""Track the main speaker (face) center over time in a video.
Emits JSON lines on stdout:
  {"type":"point","t":<sec>,"cx":<0..1 normalized center x>, "faces":<n>}
  {"type":"done"}
Face finding combines the bundled frontal + profile Haar cascades (both
orientations, so a person side-facing either way is still found). Among the
visible faces, the one whose mouth region moves most relative to the rest of
its face box between consecutive samples is treated as the active speaker,
so the crop follows the audio source instead of sticking to the person that
happened to be detected first. Pass --speech (transcript speech windows) and
the anchor only switches while someone is actually talking: whoever moves
their mouth most then is the speaker, relative mouth motion beats the
absolute floor, and silence holds the framing instead of drifting to a
listener. If no face is ever found, points are skipped so the caller can fall
back to a static center crop.

Set TRACK_DEBUG=1 to print per-sample scores to stderr.
"""
import argparse
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def overlaps(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    return inter > 0 and inter > 0.3 * min(aw * ah, bw * bh)


MAX_JUMP = 0.4  # fraction of frame width; position continuity for silent scenes
TALK_FLOOR = 6.0  # mouth motion (gray units) above whole-face motion => talking
CUT_MIN = 14.0  # whole-frame mean diff above which we treat it as a new shot
SPEECH_MARGIN = 0.35  # seconds of slack around transcript speech windows
PRE_SPEECH = 0.9  # lead time: frame the next speaker this long before their line starts


def pick_anchors(samples, speech, max_jump=MAX_JUMP, talk_floor=TALK_FLOOR, cut_min=CUT_MIN):
    """Choose which face each sample points at. `speech` is a list of (a, b)
    second-ranges (absolute source time) where the transcript says someone is
    talking. Without speech windows the legacy behavior applies: clear talker
    first, position continuity second. With them, anchor switching only
    happens while someone is speaking."""
    def speaking(t):
        return any(a - SPEECH_MARGIN <= t <= b + SPEECH_MARGIN for a, b in speech)

    def pre_speech(t):
        # the stretch of silence right before a line: the next speaker is
        # already inhaling / opening their mouth there
        return any(a - PRE_SPEECH <= t < a for a, b in speech)

    gated = bool(speech)
    out = []
    anchor = None
    cand = None  # pending switch target
    cand_n = 0  # consecutive samples the pending target has dominated
    for i, s in enumerate(samples):
        faces = s["faces"]
        if not faces:
            if anchor is not None:
                out.append((s["t"], anchor, 0))
            continue
        if gated and not speaking(s["t"]):
            cand, cand_n = None, 0
            if anchor is None:
                continue
            if pre_speech(s["t"]):
                # pre-positioning: move to the person about to speak BEFORE
                # the words start, so the shot does not sit on the last
                # speaker and whip over mid-sentence. Relaxed thresholds:
                # an inhale or mouth-opening counts as a hint.
                if len(faces) == 1:
                    f = faces[0]
                    far = abs(f["cx"] - anchor) > max_jump
                    if far and (s["cut"] >= cut_min or f["talk"] >= 1.0):
                        anchor = f["cx"]
                else:
                    ordered = sorted(faces, key=lambda f: f["talk"], reverse=True)
                    top = ordered[0]
                    if top["talk"] >= 1.0 and top["talk"] >= ordered[1]["talk"] + 1.0:
                        anchor = top["cx"]
                out.append((s["t"], anchor, len(faces)))
            else:
                # nobody is talking: hold the current framing, never re-anchor
                # (head-bobs, gestures and camera drift must not steal the shot)
                out.append((s["t"], anchor, len(faces)))
            continue
        if len(faces) == 1:
            f = faces[0]
            cand, cand_n = None, 0
            far = anchor is not None and abs(f["cx"] - anchor) > max_jump
            if far:
                nxt = samples[i + 1]["faces"] if i + 1 < len(samples) else []
                steady = any(abs(g["cx"] - f["cx"]) <= max_jump * 0.5 for g in nxt)
                # a new shot (cut) always wins; inside the same shot a far,
                # silent face is a listener, not the speaker to follow
                # while speech is active a sustained far face is the speaker
                # even if their mouth motion is subtle
                reaches = (s["cut"] >= cut_min
                           or f["talk"] >= talk_floor
                           or (gated and f["talk"] >= 2.0))
                if not steady or not reaches:
                    if anchor is not None:
                        out.append((s["t"], anchor, 0))
                    continue
            anchor = f["cx"]
            out.append((s["t"], anchor, 1))
            continue
        talker = max(faces, key=lambda f: f["talk"])
        if anchor is None and not gated:
            # no transcript to lean on: seed with the largest face
            anchor = max(faces, key=lambda f: f["area"])["cx"]
            out.append((s["t"], anchor, len(faces)))
            continue
        if anchor is None:
            # first spoken words: whoever moves most right now is talking
            anchor = talker["cx"]
            out.append((s["t"], anchor, len(faces)))
            continue
        ordered = sorted(faces, key=lambda f: f["talk"], reverse=True)
        dominant = ordered[0]["talk"] >= (ordered[1]["talk"] if len(ordered) > 1 else 0.0) + 1.5
        want = talker["cx"] if (talker["talk"] >= talk_floor or (gated and dominant and talker["talk"] >= 1.5)) else None
        # one glitched sample (face dropout, stray gesture) must not steal the
        # shot: only a target that keeps winning for two samples may switch
        if want is None:
            cand, cand_n = None, 0
        elif cand is not None and abs(want - cand) <= 0.06:
            cand_n += 1
        else:
            cand, cand_n = want, 1
        if cand_n >= 2 and abs(cand - anchor) > 0.02:
            anchor = cand
        elif cand is None:
            near = min(faces, key=lambda f: abs(f["cx"] - anchor))
            if abs(near["cx"] - anchor) <= max_jump:
                anchor = near["cx"]
        out.append((s["t"], anchor, len(faces)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--interval", type=float, default=0.7)
    ap.add_argument("--speech", default="", help="comma-separated a-b absolute seconds of speech from the transcript")
    args = ap.parse_args()
    speech = []
    for w in args.speech.split(","):
        if "-" in w:
            a, b = w.split("-", 1)
            try:
                speech.append((float(a), float(b)))
            except ValueError:
                pass

    try:
        import cv2
    except Exception as e:
        print(f"IMPORT_ERROR: opencv unavailable: {e}", file=sys.stderr)
        sys.exit(1)
    import numpy as np

    def roi_mean_diff(cur, prev, r):
        x0, y0, x1, y1 = r
        a = cur[y0:y1, x0:x1]
        b = prev[y0:y1, x0:x1]
        if a.size == 0 or b.size == 0:
            return 0.0
        return float(np.mean(np.abs(a.astype(np.int16) - b.astype(np.int16))))

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print("OPEN_ERROR: could not open video", file=sys.stderr)
        sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    base = cv2.data.haarcascades
    frontal = cv2.CascadeClassifier(base + "haarcascade_frontalface_alt2.xml")
    profile = cv2.CascadeClassifier(base + "haarcascade_profileface.xml")

    frame_idx = int(args.start * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)

    desired_ts = args.start
    samples = []
    prev_gray = None
    debug = os.environ.get("TRACK_DEBUG") == "1"

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        t = frame_idx / fps
        if t >= args.end:
            break
        if t + 1e-6 >= desired_ts:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            scale = max(1.0, 720.0 / max(1, gray.shape[0]))
            small = cv2.resize(gray, None, fx=1 / scale, fy=1 / scale, interpolation=cv2.INTER_AREA) if scale > 1 else gray
            eq = cv2.equalizeHist(small)
            sw, sh = small.shape[1], small.shape[0]
            # scene cut = whole-frame change far above ordinary in-shot motion
            cut = 0.0
            if prev_gray is not None and prev_gray.shape == small.shape:
                cut = float(np.mean(np.abs(small.astype(np.int16) - prev_gray.astype(np.int16))))
            flip = cv2.flip(eq, 1)

            def detect(cascade, img):
                r = cascade.detectMultiScale(img, scaleFactor=1.05, minNeighbors=4, minSize=(40, 40))
                return [] if r is None or len(r) == 0 else [tuple(int(v) for v in box) for box in r]

            boxes = detect(frontal, eq)
            boxes += detect(profile, eq)
            boxes += [(sw - x - w, y, w, h) for (x, y, w, h) in detect(profile, flip)]
            unique = []
            for b in boxes:
                if not any(overlaps(b, u) for u in unique):
                    unique.append(b)
            faces = []
            for (x, y, w, h) in unique:
                talk = 0.0
                if prev_gray is not None:
                    full = roi_mean_diff(small, prev_gray, (max(0, x), max(0, y), min(sw, x + w), min(sh, y + h)))
                    mouth = roi_mean_diff(small, prev_gray, (
                        max(0, x + int(w * 0.15)), max(0, y + int(h * 0.55)),
                        min(sw, x + int(w * 0.85)), min(sh, y + h),
                    ))
                    talk = max(0.0, mouth - full)
                faces.append({"cx": (x + w * 0.5) / sw, "area": w * h, "talk": talk})
            samples.append({"t": t, "faces": faces, "cut": cut})
            if debug:
                sys.stderr.write(f"t={t:.2f} cut={cut:.1f} faces={[(round(f['cx'],3), round(f['talk'],1)) for f in faces]}\n")
            prev_gray = small
            desired_ts += args.interval
        frame_idx += 1

    cap.release()

    out = pick_anchors(samples, speech)

    for (t, cx, n) in out:
        emit({"type": "point", "t": round(t, 3), "cx": round(cx, 4), "faces": n})
    emit({"type": "done", "samples": len(out)})


if __name__ == "__main__":
    main()
