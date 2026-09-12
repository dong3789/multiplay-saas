// energy-trail 클라이언트(net.ts)의 새 wire format이 multiplay-saas 서버와 호환되는지 검증
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8898;
const server = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
  cwd: '/Users/yoon/Projects/multiplay-saas',
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((r) => setTimeout(r, 2500));

let failures = 0;
const assert = (c, l) => { c ? console.log('  ok ', l) : (failures++, console.error('FAIL ', l)); };

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const msgs = [];
let room = null;
await new Promise((res) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    msgs.push(m);
    if (m.t === 'room') room = m;
    if (m.t === 'welcome') res();
  });
});
const send = (m) => ws.send(JSON.stringify(m));
const wait = (pred, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (pred()) { clearInterval(iv); res(); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
  }, 30);
});

// net.ts hello(): meta로 char/wish
send({ t: 'hello', name: '테스터', meta: { char: 'runner-cyan', wish: 'tagger' } });
// net.ts create(): game + config.map
send({ t: 'create', game: 'energy-trail', config: { map: 'park' } });
await wait(() => room);
assert(room.config.map === 'park', 'create: config.map 반영');
assert(room.players[0].char === 'runner-cyan' && room.players[0].wish === 'tagger', 'hello: meta(char/wish) 로비 공개');
// net.ts setMap/setMode(): config key/value
send({ t: 'config', key: 'map', value: 'neon' });
await wait(() => room.config.map === 'neon');
assert(true, 'setMap: config.map 변경 + 브로드캐스트');
send({ t: 'config', key: 'mode', value: 'classic' });
await wait(() => room.config.mode === 'classic');
assert(true, 'setMode: config.mode 변경 + 브로드캐스트');
// start → start 메시지에 top-level map/mode (클라 호환)
send({ t: 'start' });
await wait(() => msgs.some((m) => m.t === 'start'));
const st = msgs.find((m) => m.t === 'start');
assert(st.map === 'neon' && st.mode === 'classic', 'start: top-level map/mode (클라 호환)');
// end → 단 1회만 수신 (중복 브로드캐스트 수정 확인)
send({ t: 'score', n: 8 });
await wait(() => msgs.some((m) => m.t === 'end'));
await new Promise((r) => setTimeout(r, 300));
const ends = msgs.filter((m) => m.t === 'end');
assert(ends.length === 1, `end: 정확히 1회 수신 (got ${ends.length})`);
assert(typeof ends[0].score === 'number', 'end: score 포함');

ws.close();
server.kill();
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
