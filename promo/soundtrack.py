"""Synthesize the promo soundtrack (out/soundtrack.wav), cue-synced to video.html.

Pure synthesis (numpy + scipy), no samples, so the audio is royalty-free.
120 BPM, A minor. Cue times mirror the timeline in video.html.
"""
import os
import wave

import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
DUR = 54.0
N = int(SR * DUR)
BEAT = 0.5
rng = np.random.default_rng(3)

L = np.zeros(N)
R = np.zeros(N)
send = np.zeros(N)  # reverb send (mono)


def hz(note):
    """MIDI note -> Hz."""
    return 440.0 * 2 ** ((note - 69) / 12)


def place(sig, t, gain=1.0, pan=0.0, rev=0.0):
    i = int(t * SR)
    if i >= N:
        return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    L[i:i + len(sig)] += sig * gain * l * 1.414
    R[i:i + len(sig)] += sig * gain * r * 1.414
    send[i:i + len(sig)] += sig * gain * rev


def tt(d):
    return np.arange(int(d * SR)) / SR


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)


def saw(f, t, detune=0.0):
    out = np.zeros_like(t)
    for d in (-detune, 0.0, detune) if detune else (0.0,):
        ph = (t * f * (1 + d) + rng.random()) % 1.0
        out += 2 * ph - 1
    return out / (3 if detune else 1)


# ------------------------------------------------------------------ instruments
def kick(level=1.0):
    t = tt(0.45)
    f = 45 + 110 * np.exp(-t * 28)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-t * 7)
    click = hp(rng.standard_normal(len(t)), 2000) * np.exp(-t * 300) * 0.25
    return np.tanh((body + click) * 1.6) * level


def clap():
    t = tt(0.35)
    n = bp(rng.standard_normal(len(t)), 900, 4500)
    env = np.exp(-t * 18)
    for k in (0.0, 0.011, 0.022):
        env += np.where(t >= k, np.exp(-(t - k) * 120), 0) * 0.6
    return n * env * 0.45


def hat(open_=False):
    t = tt(0.25 if open_ else 0.06)
    n = hp(rng.standard_normal(len(t)), 7000)
    return n * np.exp(-t * (14 if open_ else 70)) * 0.22


def impact(d=3.0):
    t = tt(d)
    f = 30 + 90 * np.exp(-t * 6)
    sub = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6)
    boom = lp(rng.standard_normal(len(t)), 400) * np.exp(-t * 3.5) * 0.8
    crack = hp(rng.standard_normal(len(t)), 1500) * np.exp(-t * 9) * 0.35
    return np.tanh((sub * 1.3 + boom + crack) * 1.4)


def riser(d, lo=300, hi=9000):
    t = tt(d)
    n = rng.standard_normal(len(t))
    out = np.zeros_like(t)
    seg = 2048
    for s in range(0, len(t), seg):  # sweep a band-pass upward
        k = s / len(t)
        c = lo * (hi / lo) ** k
        out[s:s + seg] = bp(n[s:s + seg + 0], c * 0.7, min(c * 1.4, SR * 0.45))[: len(out[s:s + seg])]
    tone = np.sin(2 * np.pi * np.cumsum(220 * 2 ** (t / d * 2)) / SR) * 0.15
    return (out + tone) * (t / d) ** 2


def whoosh(d=0.9):
    t = tt(d)
    n = rng.standard_normal(len(t))
    env = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 2
    return bp(n, 400, 5000) * env * 0.5


def bell(note, d=2.5, bright=1.0):
    t = tt(d)
    f = hz(note)
    s = (np.sin(2 * np.pi * f * t) + 0.5 * bright * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 3)
         + 0.25 * bright * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 6))
    return s * np.exp(-t * 2.2) * np.minimum(1, t * 400) * 0.35


def blip(note, d=0.18):
    t = tt(d)
    return np.sin(2 * np.pi * hz(note) * t) * np.exp(-t * 28) * np.minimum(1, t * 800) * 0.3


def pad(notes, d, cutoff=1800):
    t = tt(d)
    s = sum(saw(hz(n), t, 0.004) for n in notes) / len(notes)
    s = lp(s, cutoff, 2)
    a = np.minimum(1, t / 0.4) * np.minimum(1, (d - t) / 0.6)
    return s * a


def bass(note, d):
    t = tt(d)
    s = saw(hz(note), t) * 0.6 + np.sin(2 * np.pi * hz(note) * t)
    pluck = np.exp(-t * 12)  # filter envelope: bright attack, dark tail
    s = lp(s, 1900) * pluck + lp(s, 500) * (1 - pluck)
    return s * np.minimum(1, t * 300) * np.exp(-t * 3) * np.minimum(1, (d - t) * 60)


# chords (A minor): Am, F, C, G
CHORDS = [[57, 60, 64, 71], [53, 57, 60, 67], [55, 60, 64, 67], [55, 59, 62, 69]]
ROOTS = [33, 29, 36, 31]

# ------------------------------------------------------------------ S1 intro (0 - 5): tension
t = tt(5.0)
raw = saw(hz(33), t, 0.003) + saw(hz(45), t, 0.004) * 0.5
open_ = (t / 5) ** 2  # filter opens as tension builds
drone = (lp(raw, 180) * (1 - open_) + lp(raw, 900) * open_) * np.minimum(1, t / 0.8)
place(drone, 0, 0.35, rev=0.2)
for i in range(int(4.5 / 0.125)):  # clock ticks, accelerating feel via accent
    tk = 0.5 + i * 0.125
    place(hat(), tk, 0.5 + 0.5 * (i % 4 == 0), pan=0.3 * (-1) ** i)
for tp in (0.35, 1.25, 2.15, 3.05):  # phrase slams
    place(kick(0.9), tp, 0.8)
    place(impact(1.2) * 0.5, tp, 0.45, rev=0.35)
place(riser(1.9), 3.1, 0.55, rev=0.3)
place(whoosh(0.5)[::-1], 4.5, 0.8)

# ------------------------------------------------------------------ S2 logo (5 - 9.5)
place(impact(3.5), 5.0, 1.0, rev=0.6)
place(pad([57, 64, 69, 71, 76], 4.7, 2400), 5.0, 0.28, rev=0.7)
for k, n in enumerate([81, 76, 84, 83, 88]):
    place(bell(n), 5.5 + k * 0.25, 0.55, pan=(-0.4 + 0.2 * k), rev=0.6)
place(bell(93, 3, 1.4), 6.9, 0.4, rev=0.8)  # coin shine
place(riser(1.3, 500, 7000), 8.2, 0.35)

# ------------------------------------------------------------------ groove (9.5 - 42)
g0, g1 = 9.5, 42.0
nbeats = int((g1 - g0) / BEAT)
duck = np.ones(N)  # sidechain envelope for pad/bass
for b in range(nbeats):
    tb = g0 + b * BEAT
    place(kick(), tb, 0.95)
    i = int(tb * SR)
    dt = np.arange(int(0.3 * SR)) / SR
    seg = 1 - 0.75 * np.exp(-dt * 14)
    duck[i:i + len(seg)] = np.minimum(duck[i:i + len(seg)], seg[: max(0, N - i)])
    if b % 2 == 1:
        place(clap(), tb, 0.9, rev=0.25)
    place(hat(), tb + 0.25, 0.8, pan=0.25)
    if b % 4 == 3:
        place(hat(True), tb + 0.25, 0.6, pan=-0.2)
music = np.zeros(N)
bar = 2.0
for k in range(int((g1 - g0) / bar)):
    tb = g0 + k * bar
    ci = k % 4
    seg = pad(CHORDS[ci], bar + 0.1, 1400 + 600 * (k % 2))
    i = int(tb * SR)
    music[i:i + len(seg)] += seg[: N - i] * 0.30
    for e in range(8):  # 8th-note bass
        bs = bass(ROOTS[ci] + (12 if e % 4 == 3 else 0), 0.24)
        j = int((tb + e * 0.25) * SR)
        music[j:j + len(bs)] += bs * 0.33
    # arpeggio on the upper chord tones
    for e in range(8):
        n = CHORDS[ci][[0, 1, 2, 3, 2, 1, 3, 2][e]] + 12
        place(bell(n, 0.6, 0.6), tb + e * 0.25, 0.10, pan=0.5 * np.sin(e), rev=0.5)
music *= duck
L += music
R += music
send += music * 0.25

# transitions
for tc in (16.0, 22.5, 30.0, 36.0):
    place(whoosh(0.8), tc - 0.55, 0.7, rev=0.3)
    place(impact(1.5) * 0.4, tc, 0.4, rev=0.3)
# S3 toggles: ascending pentatonic blips
for k, n in enumerate([81, 84, 86, 88, 91, 93]):
    place(blip(n, 0.25), 11.0 + k * 0.5, 0.9, pan=(-0.5 if k < 3 else 0.5), rev=0.4)
# S4 trace rows: soft ticks
for k in range(22):
    place(blip(96 + (k % 3) * 2, 0.06), 17.0 + k * 0.32, 0.35, pan=0.6)
# S5 routing zaps
for t0 in (23.2, 25.0, 26.8):
    place(whoosh(0.5), t0, 0.35, pan=-0.4)
    place(blip(88, 0.3), t0 + 0.55, 0.7, rev=0.4)
    place(whoosh(0.5), t0 + 0.75, 0.35, pan=0.4)
    place(bell(93, 1.2), t0 + 1.3, 0.35, pan=0.5, rev=0.5)
# S6 "added" dings
for k in range(3):
    place(bell(88 + k * 3, 1.0), 33.6 + k * 0.3, 0.4, pan=0.5, rev=0.5)
# S7 coins
for k in range(14):
    place(bell(100 + (k % 4), 0.4, 1.5), 37.9 + k * 0.2, 0.18, pan=0.4 * np.sin(k), rev=0.4)
place(riser(1.6), 40.4, 0.6, rev=0.3)

# ------------------------------------------------------------------ S8 montage (42 - 47)
for k in range(5):
    tb = 42.0 + k
    place(impact(1.4), tb, 0.75, rev=0.5)
    place(pad(CHORDS[[0, 1, 2, 3, 0][k]], 0.95, 3200), tb, 0.35, rev=0.5)
    place(kick(), tb + 0.5, 0.8)
    place(clap(), tb + 0.5, 0.6, rev=0.3)
place(riser(0.9, 600, 10000), 46.1, 0.6)

# ------------------------------------------------------------------ S9 finale (47 - 54)
place(impact(4.0), 47.0, 1.0, rev=0.7)
place(pad([45, 57, 64, 69, 71, 76], 6.8, 2200), 47.0, 0.34, rev=0.8)
for k, n in enumerate([81, 88, 84, 93]):
    place(bell(n, 3.0), 47.2 + k * 0.3, 0.5, pan=(-0.3 + 0.2 * k), rev=0.7)
place(bell(96, 3.5, 1.4), 48.6, 0.35, rev=0.8)

# ------------------------------------------------------------------ reverb + master
ir_t = tt(2.6)
ir = rng.standard_normal((2, len(ir_t))) * np.exp(-ir_t * 2.4)
ir = np.array([lp(ch, 5000) for ch in ir])
ir /= np.abs(ir).sum(axis=1, keepdims=True) ** 0.5 * 30
wetL = fftconvolve(send, ir[0])[:N]
wetR = fftconvolve(send, ir[1])[:N]
mixL = hp(L + wetL, 25)
mixR = hp(R + wetR, 25)
fade = np.ones(N)
fs, fe = int(52.2 * SR), N
fade[fs:fe] = np.linspace(1, 0, fe - fs) ** 2
mix = np.stack([mixL, mixR]) * fade
mix /= np.abs(mix).max()
mix = np.tanh(mix * 1.5) / np.tanh(1.5) * 0.66  # ~ -14 LUFS for web platforms

os.makedirs(os.path.join(os.path.dirname(__file__), 'out'), exist_ok=True)
path = os.path.join(os.path.dirname(__file__), 'out', 'soundtrack.wav')
with wave.open(path, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix.T * 32767).astype('<i2').tobytes())
print('wrote', path)
