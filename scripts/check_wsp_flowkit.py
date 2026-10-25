"""Opens a FreeFlow-exported workspace with FlowKit (an independent FlowJo 10
workspace reader), gates the FCS files with it, and compares every population
count with FreeFlow's own counts.

    python scripts/check_wsp_flowkit.py <dir written by wsp-roundtrip.mjs>
"""
import json
import os
import sys

import flowkit as fk

d = sys.argv[1]
ours = json.load(open(os.path.join(d, 'freeflow-counts.json')))
fcs = sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith('.fcs'))
ws = fk.Workspace(os.path.join(d, 'roundtrip.wsp'), fcs_samples=fcs)
ws.analyze_samples(group_name='All Samples', use_mp=False)
worst = 0
rows = 0
for sample_id, pops in ours.items():
    report = ws.get_gating_results(sample_id).report
    for _, r in report.iterrows():
        path = list(r['gate_path'][1:]) + [r['gate_name']]
        key = '/'.join(path)
        if key not in pops:
            continue
        theirs = int(r['count'])
        diff = abs(theirs - pops[key])
        worst = max(worst, diff)
        rows += 1
        flag = '' if diff == 0 else '   <-- differs'
        print(f'{sample_id:18} {key:42} FreeFlow {pops[key]:7d}  FlowKit {theirs:7d}{flag}')
expected = sum(len(p) for p in ours.values())
print(f'\nCompared {rows} of {expected} populations; largest difference {worst} events.')
sys.exit(0 if rows == expected and worst == 0 else 1)
