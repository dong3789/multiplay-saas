/**
 * 스모크 테스트 — 실제 서버를 띄우고 2클라이언트로 핵심 플로우 검증:
 * create → join → start → pos/peers 동기화 → score → catch → resume
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8899;
const URL = `ws://127.0.0.1:${PORT}/ws`;

const server = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));
await new Promise((r) => setTimeout(r, 2500));

let failures = 0;
function assert(cond, label) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures++;
    console.error(`FAIL  ${label}`);
  }
}

function client(name) {
  const ws = new WebSocket(URL);
  const c = {
    ws,
    name,
    id: '',
    token: '',
    msgs: [],
    room: null,
    peers: null,
    ended: null,
    ready: new Promise((res) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        c.msgs.push(m);
        if (m.t === 'welcome') {
          c.id = m.id;
          c.token = m.token;
          res();
        }
        if (m.t === 'room') c.room = m;
        if (m.t === 'peers') c.peers = m;
        if (m.t === 'end') c.ended = m;
      });
    }),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: (pred, ms = 3000) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (pred()) {
            clearInterval(iv);
            res();
          } else if (Date.now() - t0 > ms) {
            clearInterval(iv);
            rej(new Error('timeout waiting'));
          }
        }, 30);
      }),
  };
  return c;
}

try {
  // 1) 호스트: 방 생성
  const host = client('host');
  await host.ready;
  host.send({ t: 'hello', name: '호스트', meta: { char: 'runner-cyan', wish: 'tagger' } });
  host.send({ t: 'create', game: 'energy-trail' });
  await host.waitFor(() => host.room);
  assert(host.room.game === 'energy-trail', 'create: energy-trail 방 생성');
  assert(/^\d{4}$/.test(host.room.code), `create: 4자리 코드 (${host.room.code})`);
  assert(host.room.hostId === host.id, 'create: 호스트 지정');
  const code = host.room.code;

  // 2) 게스트: 참가
  const guest = client('guest');
  await guest.ready;
  guest.send({ t: 'hello', name: '게스트', meta: { char: 'runner-pink', wish: 'runner' } });
  guest.send({ t: 'join', code, token: guest.token });
  await guest.waitFor(() => guest.room && guest.room.players.length === 2);
  assert(guest.room.players.length === 2, 'join: 2명 로비');
  await host.waitFor(() => host.room.players.length === 2);
  assert(host.room.players.length === 2, 'join: 호스트에도 2명 반영');

  // 3) 게스트가 start 시도 → 무시되어야 함
  guest.send({ t: 'start' });
  await new Promise((r) => setTimeout(r, 300));
  assert(!guest.msgs.some((m) => m.t === 'start'), 'start: 비호스트 시작 무시');

  // 4) 호스트 start
  host.send({ t: 'start' });
  await host.waitFor(() => host.msgs.some((m) => m.t === 'start'));
  const startMsg = host.msgs.find((m) => m.t === 'start');
  assert(Object.keys(startMsg.roles).length === 2, 'start: 역할 배정');
  const taggerId = Object.entries(startMsg.roles).find(([, r]) => r === 'tagger')[0];
  const runnerId = Object.entries(startMsg.roles).find(([, r]) => r === 'runner')[0];
  console.log(`  ..  tagger=${taggerId === host.id ? 'host' : 'guest'}`);

  // 5) pos → peers 동기화
  const tagger = taggerId === host.id ? host : guest;
  const runner = taggerId === host.id ? guest : host;
  runner.send({ t: 'pos', x: 3, z: 4, yaw: 1 });
  await host.waitFor(() => host.peers && host.peers.list.some((p) => p.x === 3 && p.z === 4));
  assert(true, 'peers: 위치 동기화 브로드캐스트');

  // 6) score
  runner.send({ t: 'score', n: 3 });
  await host.waitFor(() => host.msgs.some((m) => m.t === 'score' && m.n === 3));
  assert(true, 'score: 자국 점수 반영');

  // 7) catch (같은 위치로 이동 후)
  tagger.send({ t: 'pos', x: 3, z: 4, yaw: 0 });
  await new Promise((r) => setTimeout(r, 200));
  tagger.send({ t: 'catch', id: runnerId });
  await host.waitFor(() => host.msgs.some((m) => m.t === 'caught' && m.id === runnerId));
  assert(true, 'catch: 서버 권위 잡기');

  // 8) resume — 게스트 소켓을 끊고 같은 토큰으로 복원
  const guestToken = guest.token;
  guest.ws.close();
  await new Promise((r) => setTimeout(r, 300));
  const guest2 = client('guest2');
  await guest2.ready;
  guest2.send({ t: 'resume', token: guestToken });
  await guest2.waitFor(() => guest2.room && guest2.id === guest.id);
  assert(guest2.id === guest.id, 'resume: 같은 플레이어 id로 복원');

  host.ws.close();
  guest2.ws.close();
} catch (err) {
  failures++;
  console.error('FAIL', err.message);
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
