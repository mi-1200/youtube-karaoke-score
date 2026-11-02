import math, struct, wave, sys
sr = 48000
mel = [60,62,64,65,67,69,67,64, 62,64,65,67,72,71,69,67]
out = []
for i, m in enumerate(mel):
    f0 = 440 * 2 ** ((m - 69) / 12)
    n = int(sr * 0.5)
    ph = 0.0
    for k in range(n):
        t = k / sr
        env = 1.0 if k < n - int(sr*0.06) else 0.0  # short gap between notes
        env *= min(1.0, k / (sr*0.01))
        f = f0 * (1 + 0.004 * math.sin(2*math.pi*5.5*t))
        ph += 2*math.pi*f/sr
        s = 0.5*math.sin(ph) + 0.2*math.sin(2*ph) + 0.08*math.sin(3*ph)
        out.append(int(max(-1,min(1,s*0.6*env)) * 32000))
w = wave.open(sys.argv[1], 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
w.writeframes(b''.join(struct.pack('<h', x) for x in out)); w.close()
