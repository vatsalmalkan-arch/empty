#!/usr/bin/env python3
"""Build a copy of the game that claude.ai artifacts can serve.

Artifacts don't serve .glb files, so each model is wrapped in a JS module
(base64); main.js falls back to it when the .glb can't be fetched. The page
skeleton (doctype/head/body) is stripped because the artifact adds its own.
Usage: python3 tools/build-artifact.py OUT_DIR
"""
import base64, os, re, shutil, sys

src = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1]
shutil.rmtree(out, ignore_errors=True)
shutil.copytree(os.path.join(src, 'js'), os.path.join(out, 'js'))
shutil.copytree(os.path.join(src, 'vendor'), os.path.join(out, 'vendor'),
                ignore=shutil.ignore_patterns('LICENSE*', '*.task'))
os.makedirs(os.path.join(out, 'assets'))
for f in os.listdir(os.path.join(src, 'assets')):
    if f.endswith('.glb'):
        data = base64.b64encode(open(os.path.join(src, 'assets', f), 'rb').read()).decode()
        open(os.path.join(out, 'assets', f + '.js'), 'w').write('export default "' + data + '";\n')
h = open(os.path.join(src, 'index.html')).read()
for pat in [r'<!doctype html>\s*', r'<html[^>]*>\s*', r'</html>\s*', r'<head>\s*', r'</head>\s*', r'<body>\s*', r'</body>\s*',
            r'<meta charset="utf-8">\s*', r'<meta name="viewport"[^>]*>\s*']:
    h = re.sub(pat, '', h, flags=re.I)
open(os.path.join(out, 'index.html'), 'w').write(h)
files = sorted(os.path.relpath(os.path.join(r, f), out) for r, _, fs in os.walk(out) for f in fs if f != 'index.html')
print(len(files), 'files')
