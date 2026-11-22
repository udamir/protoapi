"""Summarise the newest .cpuprofile in .tmp/prof by self time (top functions)."""
import collections
import json
import os
import sys

d = os.path.join(os.path.dirname(__file__), "..", ".tmp", "prof")
files = sorted(f for f in os.listdir(d) if f.endswith(".cpuprofile"))
p = json.load(open(os.path.join(d, files[-1])))
nodes = {n["id"]: n for n in p["nodes"]}
self_t = collections.Counter()
for s, dt in zip(p["samples"], p["timeDeltas"]):
    self_t[s] += dt
by_fn = collections.Counter()
for nid, t in self_t.items():
    cf = nodes[nid]["callFrame"]
    by_fn[f"{cf['functionName'] or '(anon)'} {cf['url'].split('/')[-1]}:{cf['lineNumber']}"] += t
total = sum(self_t.values())
for k, v in by_fn.most_common(int(sys.argv[1]) if len(sys.argv) > 1 else 30):
    print(f"{v / 1000:8.1f}ms {100 * v / total:5.1f}% {k}")
