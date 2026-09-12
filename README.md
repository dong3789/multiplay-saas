# multiplay-saas

> 어떤 게임이든 `GameModule` 하나만 구현하면 멀티플레이가 되는 self-hosted 멀티플레이 백엔드 프레임워크.
> 게임 IP(룰·콘텐츠)는 각 게임 레포에 그대로 두고, 룸/로비/세션/재접속/틱 동기화 인프라만 분리한 사이드 프로젝트.

## 배경: 오픈소스 멀티플레이 SaaS 조사 요약 (2026-09 기준)

| 솔루션 | 라이선스 | 스택 | 강점 | 약점 | 우리에게 시사점 |
|---|---|---|---|---|---|
| **Colyseus** | MIT | Node/TS | Room + Schema 상태 동기화, 깔끔한 API, JS 생태계 최강 | 계정/리더보드/경제 없음 (DIY) | Room 추상화 + 훅 모델의 설계 벤치마크 |
| **Nakama** | Apache-2.0 | Go + CockroachDB | 계정/소셜/채팅/리더보드/매치메이커 풀세트, Lua/TS 런타임 모듈 | 무겁다 (DB 필수), 운영 부담 | "게임 로직을 서버 플러그인으로 등록"하는 match handler 모델 참고 |
| **Hathora** | (서비스 종료) | — | 서버 호스팅 | 2026-05-05 게임 호스팅 종료 | **벤더 종속 위험의 교훈 — 룸 로직은 호스팅과 분리해야 함** |
| **Playroom** | SDK (managed) | — | 제로 백엔드, 캐주얼 최速 | 서버 권위 불가, 클라 공유 상태 모델 | 우리 게임(서버 권위 판정)에는 부적합 |
| **PartyKit/PartyServer** | 오픈소스 | Cloudflare DO | 엣지 룸 | Cloudflare 종속 | 추후 배포 타깃 옵션으로 검토 |
| **Socket.IO** | MIT | Node | 단순 WS 라이브러리 | 룸/매칭/동기화 전부 DIY | 우리 현재 상태와 동일 → 프레임워크화가 필요 |
| **Photon** | 상용 | Unity 중심 | 성숙함 | 클로즈드 소스, CCU 과금 | 제외 |

**결론**: 우리 스택(Node/TS, ws, Mac mini self-host)과 요구사항(서버 권위, 모바일 재접속, 작은 룸)에는
Colyseus를 그대로 쓰기보다 **기존 코드에서 검증된 로직(세션 resume, 유령 좌석, 호스트 승계)을 그대로 계승한
경량 자체 프레임워크**가 적합. Colyseus의 Room 모델과 Nakama의 런타임 모듈 모델을 차용해 설계했다.

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│                 GameModule (게임 IP)              │
│  energy-trail 모듈: 역할배정/잡기/아이템/살리기/승패  │
│  ※ 다른 게임 = 다른 모듈. 프로토콜은 게임별 자유.      │
├─────────────────────────────────────────────────┤
│              MultiplayServer (코어)               │
│  연결/하트비트 · 세션토큰+resume · 방코드 create/join │
│  유령좌석 재점령 · 호스트 권한/승계 · 페이즈 머신      │
│  룸 TTL/빈방 유예 · 틱 루프 · 브로드캐스트            │
├─────────────────────────────────────────────────┤
│              MultiplayClient (SDK)                │
│  자동재연결+resume · create/join/start · send/on    │
└─────────────────────────────────────────────────┘
```

### 코어 프로토콜 (모든 게임 공통)

| 메시지 | 방향 | 설명 |
|---|---|---|
| `welcome` | S→C | 접속 직후 `{id, token}` 발급 |
| `hello` | C→S | `{name, meta}` 프로필 설정 |
| `create` | C→S | `{game, config}` 방 만들기 |
| `join` | C→S | `{code, token}` 참가 (토큰으로 유령 좌석 재점령) |
| `resume` | C→S | `{token}` 끊긴 세션 복원 |
| `leave` | C→S | 방 나가기 |
| `config` | C→S | 호스트가 로비 설정 변경 `{key, value}` |
| `start` | C→S | 호스트가 게임 시작 |
| `room` | S→C | 로비 상태 전체 (코드/호스트/페이즈/플레이어) |
| `end` | S→C | 매치 종료 `{winner, reason}` |
| `err` | S→C | 에러 |

그 외 모든 메시지(`pos`, `score`, `use`, `catch` …)는 GameModule로 라우팅된다.

## 사용법

```bash
npm install
npm run dev        # tsx watch, :8791/ws
npm run typecheck
```

### 새 게임 추가

```ts
import { MultiplayServer } from './core/server.js';

const server = new MultiplayServer([], { port: 8791 });
server.register({
  id: 'my-game',
  maxPlayers: 4,
  onStart(room) { /* 역할 배정 + start 브로드캐스트 */ },
  onMessage(room, player, msg) { /* 게임 메시지 */ return false; },
  onTick(room, dtMs, now) { /* 80ms마다 상태 동기화 */ },
});
server.listen();
```

### 클라이언트

```ts
import { MultiplayClient } from './sdk/client.js';

const mp = new MultiplayClient('wss://trail.yndl.dev/ws', { storage: localStorage });
await mp.connect();
mp.hello('플레이어1', { char: 'runner-cyan', wish: 'random' });
mp.create('energy-trail');
mp.on('room', (room) => renderLobby(room));
mp.on('peers', (m) => renderPlayers(m.list));
```

## 로드맵 (SaaS화)

- [ ] 게임 모듈을 npm 패키지로 분리 (게임 레포에서 버전 관리, 서버는 런타임에 로드)
- [ ] 매치메이킹 큐 (코드 없이 자동 매칭)
- [ ] 다중 프로세스/수평 확장 (Redis presence 어댑터)
- [ ] 관리 대시보드 (/health 확장 — 활성 룸/CCU/게임별 지표)
- [ ] Unity 클라이언트 SDK (C#) — energy-trail 정식 Unity 이식 대비
- [ ] 관측성: 구조화 로그 + Prometheus 메트릭
