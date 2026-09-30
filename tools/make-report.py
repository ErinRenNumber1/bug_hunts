#!/usr/bin/env python3
"""Turn one or more Playwright trace.zip files into a single report.html for a guest-mode production run.

Usage:
  tools/make-report.py --run spec-run-5 --meta <hunt>/runs/spec-run-5.meta.json \
      --trace chromium=path/trace.zip --trace webkit=path/trace.zip ... \
      --status chromium=failed --status webkit=failed ...

  make-report.py --run spec-run-2 --meta meta.json --trace path/trace.zip --status passed   (one browser, named by --browser)

One report per spec: a browser dropdown at the top switches between one section per browser
(verdict, stills, checkout tokens, request ids, failure). Trace files unpack to runs/<run>/traces/<browser>/
and stills to runs/<run>/shots/<browser>/; only shots and report.html are committed.

meta.json keys: title, h1, subtitle, spec, store, override, moments[], proves[], caveats[].
A moment picks its still by, in order of preference:
  attachment  name passed to test.info().attach()          (popups; the only capture without a screencast)
  step        prefix of a test.step title, frame at its end
  request     regex on "METHOD STATUS host/path OperationName", frame at that request's start (+ optional "offset" seconds)
  nav         "reload": frame at the first page.reload() in the action log (+ optional "offset")
  t           seconds from the first frame (t 9999 = last frame); Chromium timing, drifts on other browsers
Captions may use {email}, {order} and {duration}; they are filled per browser from the trace.
"""
import argparse, base64, glob, json, os, re, shutil, zipfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CW = os.path.expanduser('~/world/trees/root/src/areas/clients/checkout-web')
STYLE = open(os.path.join(HERE, 'report-style.html')).read()
ELL, TIMES = '…', '×'
esc = lambda x: str(x).replace('&', '&amp;').replace('<', '&lt;')
NOISE = re.compile(r'/cdn/|shopifycdn|/assets/|monorail|/api/collect|web-pixels|/wpm@|fonts\.|otlp-http|error-analytics|atlas\.shopifysvc|checkout\.pci\.|/sandboxes/|private_access_tokens|maps\.googleapis|gstatic\.com|pay\.google\.com|play\.google\.com|clickhouse\.cloud|PublisherSettings|CountryDetails|ActivatedExtensionMetafields|observeonly|\.(js|css|png|jpe?g|svg|woff2?|ico|json)(\?|$)')

ap = argparse.ArgumentParser()
ap.add_argument('--run', required=True)
ap.add_argument('--meta', required=True)
ap.add_argument('--trace', action='append', default=[], help='browser=path/to/trace.zip (repeatable) or a bare path')
ap.add_argument('--status', action='append', default=[], help='browser=passed|failed (repeatable) or bare passed|failed for all; Playwright verdict, since trace errors alone are noisy')
ap.add_argument('--browser', default='chromium', help='browser name for a bare --trace path')
a = ap.parse_args()

traces = {}
for item in a.trace:
    b, _, p = item.partition('=') if '=' in item else (a.browser, '', item)
    traces[b] = p
if not traces: raise SystemExit('need at least one --trace')
statuses = {}
for item in a.status:
    b, _, s = item.partition('=') if '=' in item else ('*', '', item)
    if s not in ('passed', 'failed'): raise SystemExit('status must be passed or failed: ' + item)
    statuses[b] = s
meta = json.load(open(a.meta))
# Output lives next to the meta file, so one copy of this script serves every hunt folder.
run_dir = os.path.join(os.path.dirname(os.path.abspath(a.meta)), a.run)
# Previous layout kept one browser's files at the run root; clear those so the folder only holds the new layout.
for junk in ['shots', 'resources', 'attachments', 'screencast', 'src', 'trace.zip', 'frames.json'] + [os.path.basename(x) for x in glob.glob(os.path.join(run_dir, '*.trace')) + glob.glob(os.path.join(run_dir, '*.network')) + glob.glob(os.path.join(run_dir, '*.stacks'))]:
    p = os.path.join(run_dir, junk)
    if os.path.isdir(p): shutil.rmtree(p)
    elif os.path.exists(p): os.remove(p)
os.makedirs(run_dir, exist_ok=True)


def analyze(browser, trace, status):
    d = os.path.join(run_dir, 'traces', browser)
    kept = os.path.join(d, 'trace.zip')
    if os.path.abspath(trace) == os.path.abspath(kept):
        # rebuilding from the copy we keep: clear the unpacked files but not the zip itself
        for x in os.listdir(d):
            if x != 'trace.zip': (shutil.rmtree if os.path.isdir(os.path.join(d, x)) else os.remove)(os.path.join(d, x))
    else:
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d); shutil.copy(trace, kept)
    trace = kept
    shots = os.path.join(run_dir, 'shots', browser)
    shutil.rmtree(shots, ignore_errors=True); os.makedirs(shots)
    with zipfile.ZipFile(trace) as z: z.extractall(d)

    frames, errors, attachments, steps, step_ids, navs = [], [], {}, {}, {}, []
    for f in sorted(glob.glob(os.path.join(d, '*.trace'))):
        for line in open(f):
            try: e = json.loads(line)
            except ValueError: continue
            t = e.get('type')
            if t == 'screencast-frame': frames.append((e['timestamp'], os.path.join(d, e['file'])))
            elif t == 'before':
                if e.get('method') == 'test.step' and e.get('title'):
                    steps[e['title']] = [e['startTime'], None]; step_ids[e['callId']] = e['title']
                if e.get('class') == 'Page' and e.get('method') == 'reload': navs.append(e['startTime'])
            elif t == 'after':
                if e.get('callId') in step_ids: steps[step_ids[e['callId']]][1] = e['endTime']
                if e.get('error'): errors.append(e['error'].get('message', str(e['error']))[:300])
                for att in e.get('attachments') or []:
                    if att.get('file'): attachments[att['name']] = (e['endTime'], os.path.join(d, att['file']), att.get('contentType', ''))
    frames.sort(); navs.sort()
    if not frames: raise SystemExit(f'{browser}: no screencast frames in {trace}')
    t0 = frames[0][0]
    rel = lambda ts: (ts - t0) / 1000
    duration = rel(frames[-1][0])

    blob = ''
    for f in glob.glob(os.path.join(d, '*.network')) + glob.glob(os.path.join(d, '*.trace')):
        blob += open(f, errors='ignore').read()
    email = (re.findall(r'shop\.end_to_end_test\+[0-9a-f-]+@shopify\.com', blob) or ['?'])[0]
    order = (re.findall(r'#[A-Z0-9]{9}\b', blob) or ['?'])[0]
    applied = sorted(set(re.findall(r'"x-verdict-overrides-applied","value":"([^"]*)"', blob)))
    failed = status == 'failed'

    reqs = []
    for f in sorted(glob.glob(os.path.join(d, '*.network'))):
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
            reqs.append({'when': sn.get('startedDateTime', ''), 'mono': sn.get('_monotonicTime'), 'method': rq['method'], 'status': sn['response']['status'],
                         'host': host, 'path': path, 'op': op.group(1) if op else '',
                         'rid': hs.get('x-request-id') or hs.get('x-trace-id') or '', 'override': hs.get('x-verdict-overrides-applied', '')})
    # _monotonicTime shares the screencast clock, so request rows and stills line up exactly; wall clock is the fallback.
    reqs.sort(key=lambda r: (r['mono'] if r['mono'] is not None else 0, r['when']))
    first_when = reqs[0]['when'] if reqs else ''
    def rel_req(r):
        if r.get('mono') is not None: return rel(r['mono'])
        try: return (datetime.fromisoformat(r['when'].replace('Z', '+00:00')) - datetime.fromisoformat(first_when.replace('Z', '+00:00'))).total_seconds()
        except Exception: return 0.0
    seen, key_reqs = {}, []
    for r in reqs:
        k = (r['method'], r['host'], re.sub(r'/cn/[A-Za-z0-9_-]+', '/cn/_', r['path']), r['op'])
        if k in seen and (r['op'] or rel_req(r) - rel_req(seen[k]['last']) <= 1.0):
            seen[k]['n'] += 1; seen[k]['last'] = r
            if not seen[k]['rid'] and r['rid']: seen[k]['rid'] = r['rid']
            continue
        r['n'] = 1; r['last'] = r; seen[k] = r; key_reqs.append(r)

    storefront_tokens = sorted(set(re.findall(r'/checkouts?/(?:[0-9]+/)?cn/([A-Za-z0-9_-]{16,})', blob)))
    session_ids = sorted(set(re.findall(r'(?:checkout_token=|private_access_tokens\?id=|/shopify_pay/)([0-9a-f]{32})', blob)))
    trace_ids = sorted(set(re.findall(r'analytics_trace_id=([a-z0-9-]{20,})', blob)))
    ident_rows = ''.join('<div><dt>%s</dt><dd>%s</dd></div>' % (k, esc(v)) for k, v in [
        ('Storefront checkout token (URL /cn/' + ELL + ')', ', '.join(storefront_tokens) or 'none seen'),
        ('Checkout session identifier (checkout_token)', ', '.join(session_ids) or 'none seen'),
        ('analytics_trace_id', ', '.join(trace_ids) or 'none seen'),
        ('Requests captured', '%d in trace, %d shown below after dropping assets, telemetry and repeats' % (len(reqs), len(key_reqs)))])
    short_path = lambda p: re.sub(r'/cn/([A-Za-z0-9_-]{6})[A-Za-z0-9_-]+', r'/cn/\1' + ELL, p)
    def req_row(r):
        return ('<tr%s><td class="num">%.1f</td><td>%s</td><td class="num">%s</td><td>%s%s%s</td><td class="rid">%s</td></tr>' % (
            ' class="hl"' if r['override'] else '', rel_req(r), r['method'], 'aborted' if r['status'] == -1 else r['status'],
            esc(r['host'] + short_path(r['path'])), ' <b>%s</b>' % r['op'] if r['op'] else '', ' <i>%s%d</i>' % (TIMES, r['n']) if r['n'] > 1 else '',
            (esc(r['rid']) + (' <b>override applied: %s</b>' % esc(r['override']) if r['override'] else '')) if r['rid'] else '<i>not exposed</i>'))
    rows = [(rel_req(r), 1, r) for r in key_reqs] + [(rel(ts), 0, None) for ts in navs]
    rows.sort(key=lambda x: (x[0], x[1]))
    req_rows = ''.join(req_row(x) if x is not None else '<tr class="nav"><td class="num">%.1f</td><td colspan="3"><i>test action: page.reload()</i></td><td></td></tr>' % t for t, _, x in rows)
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

    figs, notes = [], []
    for i, m in enumerate(meta['moments'], 1):
        ext = '.jpeg'
        if m.get('attachment'):
            if m['attachment'] not in attachments:
                notes.append('%s: no attachment %r in this trace, moment skipped' % (m['name'], m['attachment'])); continue
            at_ts, fn, ctype = attachments[m['attachment']]
            t, ext = rel(at_ts), '.png' if 'png' in ctype else '.jpeg'
        elif m.get('step') and any(k.startswith(m['step']) for k in steps):
            hit = next(v for k, v in steps.items() if k.startswith(m['step']))
            t, fn = pick(rel(hit[1] or hit[0]))
        elif m.get('request'):
            rx = re.compile(m['request'])
            hit = next((r for r in reqs if rx.search(('%s %s %s%s %s' % (r['method'], 'aborted' if r['status'] == -1 else r['status'], r['host'], r['path'], r['op'])).strip())), None)
            if hit is None: notes.append('%s: no request matched %r, fell back to t=%s' % (m['name'], m['request'], m.get('t', 0)))
            t, fn = pick((rel_req(hit) + m.get('offset', 0)) if hit else m.get('t', 0))
        elif m.get('nav') == 'reload' and navs:
            t, fn = pick(rel(navs[0]) + m.get('offset', 0))
        else:
            t, fn = pick(m.get('t', 0))
        dst = os.path.join(shots, f"{i:02d}-{m['name']}-t{t:.1f}{ext}")
        shutil.copy(fn, dst)
        figs.append('<figure class="frame%s"><img src="%s" alt="%s at %.1f s" width="1280" height="720" loading="lazy"><figcaption><span class="t">%.1f s</span><strong>%s</strong><p>%s</p></figcaption></figure>'
                    % (' key' if m.get('key') else '', uri(dst), esc(m['title']), t, t, m['title'], fill(m['body'])))
    li = lambda items, f=True: '\n'.join('    <li>%s</li>' % (fill(x) if f else esc(x)) for x in items)
    err_block = ''
    if failed and errors:
        shown = [x for x in dict.fromkeys(errors) if 'has been closed' not in x and 'Timeout 500ms' not in x and 'Timeout 1000ms' not in x]
        err_block = '<div class="note caveat"><h3>Failure</h3><ul>%s</ul></div>' % li(shown[-4:] or errors[-3:], False)
    trace_label = 'traces/%s/trace.zip (local copy, gitignored)' % browser
    section = '''<section class="browser" data-browser="%s" hidden>
<div class="verdict%s">%s · %.1f s · production · %s</div>
<p class="sub">%s</p>
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
</section>
''' % (browser, ' fail' if failed else '', status.capitalize(), duration, esc(browser), fill(meta['subtitle']), meta['spec'], meta['store'],
       meta['override'], ', '.join(applied) or 'none seen', email, order, esc(trace_label), '\n'.join(figs), ids_block, err_block, li(meta['proves']), li(meta['caveats']))
    return {'browser': browser, 'status': status, 'duration_s': round(duration, 1), 'email': email, 'order': order, 'applied': applied,
            'storefront_tokens': storefront_tokens, 'session_ids': session_ids, 'key_requests': len(key_reqs), 'trace_errors_seen': len(errors),
            'notes': notes, 'section': section}


results = [analyze(b, p, statuses.get(b) or statuses.get('*') or 'passed') for b, p in traces.items()]
options = ''.join('<option value="%s">%s · %s · %.1f s</option>' % (esc(r['browser']), esc(r['browser']), r['status'], r['duration_s']) for r in results)
summary = ''.join('<tr><td><a href="#%s">%s</a></td><td class="%s">%s</td><td class="num">%.1f</td><td class="rid">%s</td><td class="rid">%s</td></tr>' % (
    esc(r['browser']), esc(r['browser']), 'fail' if r['status'] == 'failed' else 'pass', r['status'], r['duration_s'],
    esc(', '.join(r['session_ids']) or 'none seen'), esc(r['order'])) for r in results)
html = STYLE.replace('__TITLE__', meta['title']) + '''<div class="wrap">
<header>
  <h1>%s</h1>
  <div class="switch"><label for="browser">Browser</label><select id="browser">%s</select><span class="fine">%d browser%s in this report; the dropdown swaps every section below.</span></div>
</header>
<div class="tablewrap"><table class="reqs summary"><thead><tr><th>Browser</th><th>Result</th><th>Duration (s)</th><th>Checkout session identifier</th><th>Order</th></tr></thead><tbody>%s</tbody></table></div>
%s
</div>
<script>
(function () {
  var sel = document.getElementById('browser');
  var sections = Array.prototype.slice.call(document.querySelectorAll('section.browser'));
  function show(name) {
    if (!sections.some(function (s) { return s.dataset.browser === name; })) name = sections[0].dataset.browser;
    sections.forEach(function (s) { s.hidden = s.dataset.browser !== name; });
    sel.value = name;
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  }
  sel.addEventListener('change', function () { show(sel.value); });
  window.addEventListener('hashchange', function () { show(location.hash.slice(1)); });
  document.querySelectorAll('table.summary a').forEach(function (a) { a.addEventListener('click', function (ev) { ev.preventDefault(); show(a.getAttribute('href').slice(1)); }); });
  show(location.hash.slice(1));
})();
</script>
''' % (meta['h1'], options, len(results), '' if len(results) == 1 else 's', summary, '\n'.join(r['section'] for r in results))
open(os.path.join(run_dir, 'report.html'), 'w').write(html)
for r in results:
    for n in r['notes']: print('%s: %s' % (r['browser'], n))
print(json.dumps([{k: v for k, v in r.items() if k not in ('section', 'notes')} for r in results], indent=1))
print('report:', os.path.join(run_dir, 'report.html'))
