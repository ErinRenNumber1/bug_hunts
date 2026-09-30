#!/usr/bin/env python3
"""Turn a Playwright trace.zip into shots/ + report.html for a guest-mode production run.

Usage:
  make-report.py --run spec-run-3 --meta meta.json [--trace path/to/trace.zip] [--spec-glob '*lucasmri*reload*']

If --trace is omitted, the newest trace.zip under checkout-web/test-results matching --spec-glob is used.
meta.json keys: title, subtitle, spec, store, override, case, moments[{t,name,title,body,key}], proves[], caveats[].
Captions may use {email}, {order} and {duration}; they are filled from the trace.
"""
import argparse, base64, glob, json, os, re, shutil, subprocess, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'runs')  # runs/spec-run-N; the trace files unpacked there are gitignored
TEST_RESULTS = os.path.expanduser('~/world/trees/root/src/areas/clients/checkout-web/test-results')
STYLE = open(os.path.join(HERE, 'report-style.html')).read()

ap = argparse.ArgumentParser()
ap.add_argument('--run', required=True)
ap.add_argument('--meta', required=True)
ap.add_argument('--trace')
ap.add_argument('--spec-glob', default='*')
ap.add_argument('--status', choices=['passed','failed'], default='passed', help='Playwright verdict from the run output; trace errors alone are noisy (swallowed waits also log)')
a = ap.parse_args()

trace = a.trace
if not trace:
    cands = glob.glob(os.path.join(TEST_RESULTS, a.spec_glob, 'trace.zip'))
    if not cands: raise SystemExit('no trace.zip found under ' + TEST_RESULTS)
    trace = max(cands, key=os.path.getmtime)
run_dir = os.path.join(OUT, a.run)
shutil.rmtree(os.path.join(run_dir, 'shots'), ignore_errors=True)
os.makedirs(os.path.join(run_dir, 'shots'))
if os.path.abspath(trace) != os.path.abspath(os.path.join(run_dir, 'trace.zip')): shutil.copy(trace, os.path.join(run_dir, 'trace.zip'))
with zipfile.ZipFile(trace) as z: z.extractall(run_dir)
meta = json.load(open(a.meta))

# --- index frames, actions, errors, identity -------------------------------------------------
frames, errors, actions, attachments = [], [], {}, {}
navs = []  # page.reload() times from the action log, shown as marker rows in the request table
for f in sorted(glob.glob(os.path.join(run_dir, '*.trace'))):
    for line in open(f):
        try: e = json.loads(line)
        except ValueError: continue
        t = e.get('type')
        if t == 'screencast-frame': frames.append((e['timestamp'], os.path.join(run_dir, e['file'])))
        elif t == 'before':
            actions[e['callId']] = [e['startTime'], e.get('apiName', ''), None]
            if e.get('class') == 'Page' and e.get('method') == 'reload':
                navs.append(e['startTime'])
        elif t == 'after':
            if e.get('callId') in actions: actions[e['callId']][2] = e['endTime']
            if e.get('error'): errors.append(e['error'].get('message', str(e['error']))[:300])
            for att in e.get('attachments') or []:
                if att.get('file'): attachments[att['name']] = (e['endTime'], os.path.join(run_dir, att['file']), att.get('contentType', ''))
frames.sort()
navs.sort()
t0 = frames[0][0]
rel = lambda ts: (ts - t0) / 1000
duration = rel(frames[-1][0])
json.dump([{'t': round(rel(ts), 2), 'file': os.path.relpath(fn, run_dir)} for ts, fn in frames], open(os.path.join(run_dir, 'frames.json'), 'w'))

blob = ''
for f in glob.glob(os.path.join(run_dir, '*.network')) + glob.glob(os.path.join(run_dir, '*.trace')):
    blob += open(f, errors='ignore').read()
email = (re.findall(r'shop\.end_to_end_test\+[0-9a-f-]+@shopify\.com', blob) or ['?'])[0]
order = (re.findall(r'#[A-Z0-9]{9}\b', blob) or ['?'])[0]
applied = sorted(set(re.findall(r'"x-verdict-overrides-applied","value":"([^"]*)"', blob)))
status = a.status.capitalize()
failed = status == 'Failed'

# --- checkout tokens and key requests -----------------------------------------------------------
NOISE = re.compile(r'/cdn/|shopifycdn|/assets/|monorail|/api/collect|web-pixels|/wpm@|fonts\.|otlp-http|error-analytics|atlas\.shopifysvc|checkout\.pci\.|/sandboxes/|private_access_tokens|maps\.googleapis|gstatic\.com|pay\.google\.com|play\.google\.com|clickhouse\.cloud|PublisherSettings|CountryDetails|ActivatedExtensionMetafields|observeonly|\.(js|css|png|jpe?g|svg|woff2?|ico|json)(\?|$)')
reqs = []
for f in sorted(glob.glob(os.path.join(run_dir, '*.network'))):
    for line in open(f):
        try: e = json.loads(line)
        except ValueError: continue
        if e.get('type') != 'resource-snapshot': continue
        sn = e['snapshot']; rq = sn['request']; url = rq['url']
        if NOISE.search(url): continue
        hs = {h['name'].lower(): h['value'] for h in sn['response'].get('headers', [])}
        u = re.match(r'https?://([^/]+)(/[^?#]*)', url)
        host, path = (u.group(1), u.group(2)) if u else (url, '')
        op = re.search(r'operationName=([A-Za-z]+)', url)
        reqs.append({'when': sn.get('startedDateTime', ''), 'method': rq['method'], 'status': sn['response']['status'],
                     'host': host, 'path': path, 'op': op.group(1) if op else '',
                     'rid': hs.get('x-request-id') or hs.get('x-trace-id') or '', 'override': hs.get('x-verdict-overrides-applied', '')})
reqs.sort(key=lambda r: r['when'])
first_when = reqs[0]['when'] if reqs else ''
from datetime import datetime
def rel_when(w):
    try: return (datetime.fromisoformat(w.replace('Z', '+00:00')) - datetime.fromisoformat(first_when.replace('Z', '+00:00'))).total_seconds()
    except Exception: return 0.0
seen, key_reqs = {}, []
for r in reqs:
    k = (r['method'], r['host'], re.sub(r'/cn/[A-Za-z0-9_-]+', '/cn/_', r['path']), r['op'])
    if k in seen and (r['op'] or rel_when(r['when']) - rel_when(seen[k]['last']) <= 1.0):
        seen[k]['n'] += 1; seen[k]['last'] = r['when']
        if not seen[k]['rid'] and r['rid']: seen[k]['rid'] = r['rid']  # a later repeat may be the one that exposed an id
        continue
    r['n'] = 1; r['last'] = r['when']; seen[k] = r; key_reqs.append(r)

storefront_tokens = sorted(set(re.findall(r'/checkouts?/(?:[0-9]+/)?cn/([A-Za-z0-9_-]{16,})', blob)))
session_ids = sorted(set(re.findall(r'(?:checkout_token=|private_access_tokens\?id=|/shopify_pay/)([0-9a-f]{32})', blob)))
trace_ids = sorted(set(re.findall(r'analytics_trace_id=([a-z0-9-]{20,})', blob)))
esc = lambda x: str(x).replace('&', '&amp;').replace('<', '&lt;')
ELL = '…'; TIMES = '×'
ident_rows = ''.join('<div><dt>%s</dt><dd>%s</dd></div>' % (k, esc(v)) for k, v in [
    ('Storefront checkout token (URL /cn/' + ELL + ')', ', '.join(storefront_tokens) or 'none seen'),
    ('Checkout session identifier (checkout_token)', ', '.join(session_ids) or 'none seen'),
    ('analytics_trace_id', ', '.join(trace_ids) or 'none seen'),
    ('Requests captured', '%d in trace, %d shown below after dropping assets, telemetry and repeats' % (len(reqs), len(key_reqs)))])
def short_path(p): return re.sub(r'/cn/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+', r'/cn/\1' + ELL, p)
def req_rows_one(r):
    return ('<tr%s><td class="num">%.1f</td><td>%s</td><td class="num">%s</td><td>%s%s%s</td><td class="rid">%s</td></tr>' % (
    ' class="hl"' if r['override'] else '', rel_when(r['when']), r['method'], 'aborted' if r['status'] == -1 else r['status'],
    esc(r['host'] + short_path(r['path'])),
    ' <b>%s</b>' % r['op'] if r['op'] else '', ' <i>%s%d</i>' % (TIMES, r['n']) if r['n'] > 1 else '',
    (esc(r['rid']) + (' <b>override applied: %s</b>' % esc(r['override']) if r['override'] else '')) if r['rid'] else '<i>not exposed</i>'))
# Marker rows for page.reload(); the action log and the frames share a clock, and the first request is the initial goto, so both are t=0.
rows_list = [(rel_when(r['when']), 1, r) for r in key_reqs] + [(rel(ts), 0, None) for ts in navs]
rows_list.sort(key=lambda x: (x[0], x[1]))
req_rows = ''.join(req_rows_one(x) if x is not None else '<tr class="nav"><td class="num">%.1f</td><td colspan="3"><i>test action: page.reload()</i></td><td></td></tr>' % t for t, _, x in rows_list)
ids_block = ('<h2>Trace identifiers</h2>\n<dl class="meta">%s</dl>\n'
    '<div class="tablewrap"><table class="reqs"><thead><tr><th>t (s)</th><th>Method</th><th>Status</th><th>Endpoint</th><th>x-request-id</th></tr></thead><tbody>%s</tbody></table></div>\n'
    '<p class="fine">Request IDs come from the x-request-id response header (x-trace-id as fallback). Checkout-renderer documents on shop.app do not expose one. '
    + TIMES + 'N marks a request repeated N times; only the first is listed (GraphQL always; documents only within a one-second burst, so a reload of the same page stays visible). The highlighted row carried X-Verdict-Overrides-Applied. Italic rows are test actions from the Playwright action log.</p>\n') % (ident_rows, req_rows)

def pick(t):
    for ts, fn in frames:
        if rel(ts) >= t: return rel(ts), fn
    return rel(frames[-1][0]), frames[-1][1]

fill = lambda s: s.format(email=email, order=order, duration=f'{duration:.1f}')
uri = lambda p: 'data:image/%s;base64,' % ('png' if p.endswith('.png') else 'jpeg') + base64.b64encode(open(p, 'rb').read()).decode()

figs = []
for i, m in enumerate(meta['moments'], 1):
    if m.get('attachment'):
        # test.info().attach screenshot; the only capture of a page with no screencast (popup windows)
        at_ts, fn, ctype = attachments[m['attachment']]
        t, ext = rel(at_ts), '.png' if 'png' in ctype else '.jpeg'
    else:
        t, fn = pick(m['t']); ext = '.jpeg'
    dst = os.path.join(run_dir, 'shots', f"{i:02d}-{m['name']}-t{t:.1f}{ext}")
    shutil.copy(fn, dst)
    figs.append('<figure class="frame%s"><img src="%s" alt="%s at %.1f s" width="1280" height="720"><figcaption><span class="t">%.1f s</span><strong>%s</strong><p>%s</p></figcaption></figure>'
                % (' key' if m.get('key') else '', uri(dst), m['title'], t, t, m['title'], fill(m['body'])))

li = lambda items, f=True: '\n'.join('    <li>%s</li>' % (fill(x) if f else x.replace('<','&lt;')) for x in items)
err_block = ''
if failed and errors:
    shown = [x for x in dict.fromkeys(errors) if 'has been closed' not in x and 'Timeout 500ms' not in x and 'Timeout 1000ms' not in x]
    err_block = '<div class="note caveat"><h3>Failure</h3><ul>%s</ul></div>' % li(shown[-4:] or errors[-3:], False)

html = STYLE.replace('__TITLE__', meta['title']) + '''<div class="wrap">
<header>
  <div class="verdict%s">%s · %.1f s · production</div>
  <h1>%s</h1>
  <p>%s</p>
</header>
<dl class="meta">
  <div><dt>Spec</dt><dd>%s</dd></div>
  <div><dt>Store</dt><dd>%s</dd></div>
  <div><dt>Variant override</dt><dd>%s · X-Verdict-Overrides-Applied: %s</dd></div>
  <div><dt>Buyer</dt><dd>%s (benchmark alias)</dd></div>
  <div><dt>Order</dt><dd>%s</dd></div>
  <div><dt>Trace</dt><dd>%s</dd></div>
</dl>
<h2>Timeline</h2>
<div class="strip">
%s
</div>
%s
<h2>Reading the result</h2>
<div class="notes">
  %s
  <div class="note"><h3>What this run proves</h3><ul>
%s
  </ul></div>
  <div class="note caveat"><h3>What it does not prove</h3><ul>
%s
  </ul></div>
</div>
</div>
''' % (' fail' if failed else '', status, duration, meta['h1'], fill(meta['subtitle']), meta['spec'], meta['store'],
       meta['override'], ', '.join(applied) or 'none seen', email, order,
       os.path.relpath(trace, os.path.dirname(TEST_RESULTS)), '\n'.join(figs), ids_block, err_block, li(meta['proves']), li(meta['caveats']))
open(os.path.join(run_dir, 'report.html'), 'w').write(html)
print(json.dumps({'status': status, 'duration_s': round(duration, 1), 'email': email, 'order': order, 'applied': applied, 'storefront_tokens': storefront_tokens, 'session_ids': session_ids, 'key_requests': len(key_reqs),
                  'trace_errors_seen': len(errors), 'report': os.path.join(run_dir, 'report.html')}, indent=1))
