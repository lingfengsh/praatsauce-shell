# -*- coding: utf-8 -*-
"""生成几个合成元音样本，供第一次使用时试跑（不需要真实录音）。

用最简单的源-滤波模型：声门脉冲串激励 + 三个并联共振峰谐振器，
这样 Praat 能正常测出 F0 和 F1/F2/F3。
"""

import os
import math
import wave
import struct
import random

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")


def synth(path, f0, dur=0.7, fs=16000, formants=((500, 70), (1500, 100), (2500, 140)),
          drift=-0.12, noise=0.004, amp=0.55, seed=1):
    rnd = random.Random(seed)
    n = int(dur * fs)

    # --- 声源：带轻微抖动和音高下滑的脉冲串
    exc = [0.0] * n
    t = 0.0
    i = 0
    while t < dur:
        pos = int(t * fs)
        jitter = 1.0 + (rnd.random() - 0.5) * 0.01
        for k in range(14):
            if pos + k < n:
                exc[pos + k] += math.exp(-k / 3.2) * jitter
        cur_f0 = f0 * (1.0 + drift * (t / dur))
        t += 1.0 / max(cur_f0, 20)

    # --- 三个并联共振峰谐振器
    out = [0.0] * n
    for idx, (f, bw) in enumerate(formants):
        r = math.exp(-math.pi * bw / fs)
        theta = 2 * math.pi * f / fs
        a1 = 2 * r * math.cos(theta)
        a2 = -r * r
        y1 = y2 = 0.0
        gain = 1.0 / (1 + idx * 0.9)
        for i in range(n):
            y0 = exc[i] + a1 * y1 + a2 * y2
            out[i] += gain * y0
            y2, y1 = y1, y0

    # --- 加一点底噪（否则 HNR 会高得不真实）+ 淡入淡出
    peak = max(abs(v) for v in out) or 1.0
    fade = int(0.02 * fs)
    frames = bytearray()
    for i in range(n):
        v = out[i] / peak * amp
        v += (rnd.random() - 0.5) * noise
        if i < fade:
            v *= i / fade
        if i > n - fade:
            v *= max(0, (n - i) / fade)
        v = max(-1.0, min(1.0, v))
        frames += struct.pack("<h", int(v * 32000))

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(fs)
        w.writeframes(bytes(frames))
    return path


SPECS = [
    ("示例_男声_a_120Hz.wav", 120, ((800, 80), (1200, 110), (2600, 160))),
    ("示例_女声_i_210Hz.wav", 210, ((300, 60), (2300, 130), (3000, 170))),
    ("示例_男声_u_095Hz.wav", 95, ((350, 70), (800, 100), (2400, 150))),
]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, f0, fmts in SPECS:
        p = os.path.join(OUT_DIR, name)
        synth(p, f0, formants=fmts)
        print("生成", p, os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
