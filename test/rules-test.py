"""
Runs the ainotelayer database rules in the Firebase emulator against the
payloads the overlay really writes (taken from the local store).
"""
import json, sys, urllib.request, urllib.error

EMU, NS, STORE = sys.argv[1], sys.argv[2], sys.argv[3]
R = 'rules-test-review'

def call(method, path, body=None):
    url = f'{EMU}/{path}.json?ns={NS}'
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b'null'), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null'), dict(e.headers)

results = []
def check(name, got, want_ok):
    ok = (got[0] == 200) == want_ok
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}: HTTP {got[0]}" + ('' if ok else f'  {got[1]}'))

store = json.load(open(STORE))
shot_id = next(iter(store['shots']))
nested_id = next(k for k, v in store['notes'].items() if v['anchor'].get('containers'))
note, nested, shot = store['notes'][shot_id], store['notes'][nested_id], store['shots'][shot_id]
base = f'reviews/{R}'

print('-- what must be refused')
check('list the whole database', call('GET', ''), False)
check('list all reviews', call('GET', 'reviews'), False)
check('write at a review root', call('PUT', base, {'x': 1}), False)
check('reply to a note that does not exist', call('POST', f'{base}/notes/nope/messages', {'author': 'a', 'text': 't', 'at': 'now'}), False)
check('status change on a note that does not exist', call('PATCH', f'{base}/notes/nope', {'status': 'fix'}), False)

print('-- what the overlay writes')
check('build info', call('PUT', f'{base}/meta', {'app': 'slim', 'branch': 'feat/x', 'sha': 'add890b'}), True)
check('note on the slide (real payload)', call('PUT', f'{base}/notes/{shot_id}', note), True)
check('note inside two sections (real payload)', call('PUT', f'{base}/notes/{nested_id}', nested), True)
check(f'slide picture ({len(shot) // 1024} KB data URL)', call('PUT', f'{base}/shots/{shot_id}', shot), True)
check('reply', call('POST', f'{base}/notes/{shot_id}/messages', {'author': 'IO', 'text': 'ok', 'at': '2026-11-16T20:00:00Z'}), True)

print('-- what an agent writes')
check('agent reply', call('POST', f'{base}/notes/{shot_id}/messages', {'author': 'Igor/Claude', 'agent': True, 'text': 'looked', 'at': '2026-11-16T20:01:00Z'}), True)
check('status fix + resolution', call('PATCH', f'{base}/notes/{shot_id}', {'status': 'fix', 'resolution': 'PR #451'}), True)

print('-- abuse the rules should stop')
check('unknown status', call('PATCH', f'{base}/notes/{shot_id}', {'status': 'bogus'}), False)
check('reply with an extra field', call('POST', f'{base}/notes/{shot_id}/messages', {'author': 'a', 'text': 't', 'at': 'now', 'html': '<b>'}), False)
check('reply over 8000 characters', call('POST', f'{base}/notes/{shot_id}/messages', {'author': 'a', 'text': 'x' * 8001, 'at': 'now'}), False)
check('reply with no author', call('POST', f'{base}/notes/{shot_id}/messages', {'text': 't', 'at': 'now'}), False)
check('picture that is not an image', call('PUT', f'{base}/shots/zzz', 'javascript:alert(1)'), False)
check('picture over the size cap', call('PUT', f'{base}/shots/zzz', 'data:image/webp;base64,' + 'A' * 600001), False)
check('wipe every note at once', call('DELETE', f'{base}/notes'), False)
check('wipe the whole review', call('DELETE', base), False)

print('-- what comes back')
status, back, headers = call('GET', f'{base}/notes/{nested_id}')
a = back['anchor']
print('   trail is a list:', isinstance(back.get('trail'), list), '| components is a list:', isinstance(a.get('components'), list),
      '| containers is a list:', isinstance(a.get('containers'), list), '| messages keys:', list(back['messages'].keys()))
status, back2, _ = call('GET', f'{base}/notes/{shot_id}')
print('   empty containers dropped:', 'containers' not in back2['anchor'], '| status:', back2['status'], '| resolution:', back2.get('resolution'),
      '| replies:', len(back2['messages']) - 1)
print('   CORS header on a read:', headers.get('Access-Control-Allow-Origin') or headers.get('access-control-allow-origin'))
check('delete one note (allowed: public write)', call('DELETE', f'{base}/notes/{nested_id}'), True)
print(f"\n{sum(results)}/{len(results)} checks as expected")
