import type { CoreContext, GameModule, Player, Room } from '../../core/types.js';

/**
 * Energy Trail (자국-술래잡기) 게임 모듈.
 *
 * 기존 web-prototype/server/index.mjs (922줄 모놀리스)에서 게임 규칙만 추출해
 * GameModule 인터페이스로 포팅한 것. 룸/세션/재접속/호스트 승계는 코어가 처리하므로
 * 이 파일에는 순수 게임 로직(역할 배정, 이동 동기화, 잡기, 아이템, 살리기, 승패)만 남는다.
 *
 * → 게임 IP는 energy-trail 레포에 그대로 두고, 이 모듈만 SaaS에 등록하는 구조.
 */

const ROUND_SECONDS = 75;
const TRAIL_GOAL = 8;
const CATCH_DIST = 1.65;
const MAP_WIDTH = 42;
const MAP_DEPTH = 42;
const TAGGER_WIN_OUT_COUNT = 2;

const REVIVE_TRAIL_COST = 3;
const REVIVE_NO_LAST_SECONDS = 10.0;
const REVIVE_RANGE = 3.5;
const REVIVE_INVULNERABLE_SECONDS = 1.0;
const REVIVE_EDGE_MARGIN = 3.0;
const REVIVE_COOLDOWN_MS = 8000;

const SHIELD_MS = 8000;
const ICE_RANGE = 8;
const ICE_DURATION_MS = 2400;
const ICE_COOLDOWN_MS = 10000;
const SCORE_MIN_INTERVAL_MS = 250;
const SCORE_MAX_ADD = 10;

const ALLOWED_ITEM_KINDS = new Set([
  'jelly', 'smoke', 'sticky', 'decoy', 'magnet',
  'shield', 'dash', 'reversal', 'rocket', 'invis',
]);

function dist(a: Record<string, any>, b: Record<string, any>) {
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function assignRoles(players: Player[]): Record<string, 'tagger' | 'runner'> {
  const hopefuls = players.filter((p) => p.meta.wish === 'tagger');
  const notRunner = players.filter((p) => p.meta.wish !== 'runner');
  const pool = hopefuls.length ? hopefuls : notRunner.length ? notRunner : players;
  const tagger = pool[Math.floor(Math.random() * pool.length)];
  const roles: Record<string, 'tagger' | 'runner'> = {};
  for (const p of players) roles[p.id] = p.id === tagger.id ? 'tagger' : 'runner';
  return roles;
}

function pickEdgeSpawn(tx: number, tz: number, hx: number, hz: number) {
  const halfW = MAP_WIDTH / 2;
  const halfD = MAP_DEPTH / 2;
  const dLeft = Math.abs(hx - -halfW);
  const dRight = Math.abs(hx - halfW);
  const dTop = Math.abs(hz - -halfD);
  const dBottom = Math.abs(hz - halfD);
  const m = REVIVE_EDGE_MARGIN;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return { x: -halfW + m, z: clamp(hz, -halfD + m, halfD - m) };
  if (min === dRight) return { x: halfW - m, z: clamp(hz, -halfD + m, halfD - m) };
  if (min === dTop) return { x: clamp(hx, -halfW + m, halfW - m), z: -halfD + m };
  return { x: clamp(hx, -halfW + m, halfW - m), z: halfD - m };
}

export function createEnergyTrailModule(ctx: CoreContext): GameModule {
  const role = (p: Player) => p.state.role as 'tagger' | 'runner' | '';
  const isOut = (p: Player) => !!p.state.out;

  function end(room: Room, winner: string, reason: string) {
    ctx.endRoom(room, winner, reason, { score: room.state.score });
  }

  return {
    id: 'energy-trail',
    version: '0.1.0',
    maxPlayers: 5,

    defaults: () => ({
      config: { map: 'park', mode: 'items' },
      state: { score: 0, lastReviveAt: {} as Record<string, number> },
    }),

    publicPlayer: (_room, p) => ({
      role: role(p) || undefined,
      out: isOut(p),
    }),

    onConfigChange: (_room, _player, key, value) => {
      if (key === 'map' && typeof value === 'string') return true;
      if (key === 'mode') return value === 'classic' ? 'classic' : 'items'; // 정규화 값 반영
      return false; // 그 외 키는 거부
    },

    // 닉네임이 유일하면 유령 좌석 재점령 허용 (기존 join-policy의 findGhostByUniqueName)
    findReclaimable: (room, player) => {
      const matches = [...room.players.values()].filter(
        (p) => p.ws === null && p.name === player.name,
      );
      const all = [...room.players.values()].filter((p) => p.name === player.name);
      return matches.length === 1 && all.length === 1 ? matches[0] : null;
    },

    onStart: (room) => {
      const players = [...room.players.values()];
      const roles = assignRoles(players);
      const taggerAt = { x: 12, z: 12 };
      const runnerSpawns = [
        { x: -12, z: -4 },
        { x: -10, z: 10 },
        { x: 10, z: -10 },
        { x: 0, z: -14 },
      ];
      let i = 0;
      const spawns: Record<string, { x: number; z: number }> = {};
      for (const p of players) {
        p.state.role = roles[p.id];
        p.state.out = false;
        p.state.invulnUntil = 0;
        p.state.shieldUntil = 0;
        p.state.frozenUntil = 0;
        const pos = roles[p.id] === 'tagger' ? taggerAt : runnerSpawns[i++ % runnerSpawns.length];
        p.state.x = pos.x;
        p.state.z = pos.z;
        p.state.yaw = 0;
        p.state.prevX = pos.x;
        p.state.prevZ = pos.z;
        p.state.vx = 0;
        p.state.vz = 0;
        spawns[p.id] = { x: pos.x, z: pos.z };
      }
      room.state.score = 0;
      room.state.lastReviveAt = {};
      ctx.broadcast(room, {
        t: 'start',
        roles,
        map: room.config.map,
        mode: room.config.mode,
        players: players.map((p) => ctx.publicPlayer(room, p)),
        spawns,
        roundSeconds: ROUND_SECONDS,
        trailGoal: TRAIL_GOAL,
        roundStartedAt: room.startedAt,
      });
    },

    onMessage: (room, player, msg) => {
      const now = Date.now();
      const s = player.state;

      if (msg.t === 'wish' && typeof msg.wish === 'string') {
        player.meta.wish = msg.wish;
        ctx.broadcastRoom(room);
        return true;
      }
      if (msg.t === 'char' && typeof msg.char === 'string') {
        player.meta.char = msg.char;
        ctx.broadcastRoom(room);
        return true;
      }
      if (msg.t === 'pos' && room.phase === 'playing') {
        if (typeof msg.x === 'number') s.x = msg.x;
        if (typeof msg.z === 'number') s.z = msg.z;
        if (typeof msg.yaw === 'number') s.yaw = msg.yaw;
        return true;
      }
      if (
        msg.t === 'score' && room.phase === 'playing' &&
        role(player) === 'runner' && !isOut(player) &&
        typeof msg.n === 'number' && Number.isFinite(msg.n)
      ) {
        if (now - (s.lastScoreAt || 0) < SCORE_MIN_INTERVAL_MS) return true;
        s.lastScoreAt = now;
        const add = Math.max(1, Math.min(SCORE_MAX_ADD, Math.floor(msg.n)));
        room.state.score += add;
        ctx.broadcast(room, { t: 'score', n: room.state.score });
        if (room.state.score >= TRAIL_GOAL) end(room, 'runner', `자국 ${TRAIL_GOAL}개 수집`);
        return true;
      }
      if (msg.t === 'use' && room.phase === 'playing' && role(player) === 'runner' && !isOut(player)) {
        if (room.config.mode === 'classic') return true;
        const kind = String(msg.kind || '').slice(0, 12);
        if (!ALLOWED_ITEM_KINDS.has(kind)) return true;
        if (now - (s.lastUseAt || 0) < 400) return true;
        s.lastUseAt = now;
        if (kind === 'shield') s.shieldUntil = now + SHIELD_MS;
        ctx.broadcast(room, { t: 'use', id: player.id, kind }, player.id);
        return true;
      }
      if (msg.t === 'ice' && room.phase === 'playing' && role(player) === 'runner' && !isOut(player)) {
        if (now - (s.lastIceAt || 0) < ICE_COOLDOWN_MS) return true;
        const tagger = [...room.players.values()].find((p) => role(p) === 'tagger');
        if (!tagger) return true;
        if (dist(s, tagger.state) > ICE_RANGE + 2) return true;
        s.lastIceAt = now;
        tagger.state.frozenUntil = now + ICE_DURATION_MS;
        ctx.broadcast(room, { t: 'ice', id: player.id, until: tagger.state.frozenUntil });
        return true;
      }
      if (msg.t === 'catch' && room.phase === 'playing' && role(player) === 'tagger') {
        if (s.frozenUntil && s.frozenUntil > now) return true;
        const target = room.players.get(String(msg.id || ''));
        if (
          target && role(target) === 'runner' && !isOut(target) &&
          dist(s, target.state) <= CATCH_DIST + 2
        ) {
          if (target.state.shieldUntil && target.state.shieldUntil > now) {
            ctx.broadcast(room, { t: 'shieldblock', id: target.id });
            return true;
          }
          target.state.out = true;
          ctx.broadcast(room, { t: 'caught', id: target.id });
        }
        return true;
      }
      if (msg.t === 'revive' && room.phase === 'playing' && role(player) === 'runner' && !isOut(player)) {
        const deny = (reason: string) => ctx.send(player, { t: 'reviveDenied', reason });
        const target = room.players.get(String(msg.id || ''));
        if (!target) return deny('no_target'), true;
        if (role(target) !== 'runner' || !isOut(target)) return deny('target_not_out'), true;
        if (target.id.startsWith('ai_') || target.name.startsWith('AI')) return deny('target_is_ai'), true;
        if (dist(s, target.state) > REVIVE_RANGE) return deny('target_too_far'), true;
        const lastReviveAt = room.state.lastReviveAt[target.id];
        if (lastReviveAt && now - lastReviveAt < REVIVE_COOLDOWN_MS) return deny('cooldown'), true;
        if (room.state.score < REVIVE_TRAIL_COST) return deny('not_enough_trail'), true;
        const left = ROUND_SECONDS - (now - room.startedAt) / 1000;
        if (left <= REVIVE_NO_LAST_SECONDS) return deny('too_late'), true;

        room.state.score -= REVIVE_TRAIL_COST;
        const edge = pickEdgeSpawn(target.state.x, target.state.z, s.x, s.z);
        target.state.x = edge.x;
        target.state.z = edge.z;
        target.state.yaw = 0;
        target.state.out = false;
        target.state.invulnUntil = now + REVIVE_INVULNERABLE_SECONDS * 1000;
        room.state.lastReviveAt[target.id] = now;
        ctx.broadcast(room, { t: 'score', n: room.state.score });
        ctx.broadcast(room, {
          t: 'revived',
          id: target.id,
          x: edge.x,
          z: edge.z,
          invulnUntil: target.state.invulnUntil,
        });
        return true;
      }
      return false;
    },

    onTick: (room, dtMs, now) => {
      const elapsed = (now - room.startedAt) / 1000;
      const left = ROUND_SECONDS - elapsed;
      if (left <= 0) return end(room, 'tagger', `자국 ${room.state.score}/${TRAIL_GOAL}`);
      if (room.state.score >= TRAIL_GOAL) return end(room, 'runner', `자국 ${TRAIL_GOAL}개 수집`);

      const players = [...room.players.values()];
      const taggers = players.filter((p) => role(p) === 'tagger' && !isOut(p));
      const runners = players.filter((p) => role(p) === 'runner');
      const taggerLive = taggers.some((p) => p.ws !== null);
      const taggerPreserved = players.some((p) => role(p) === 'tagger' && p.ws === null);
      if (taggers.length === 0 || (!taggerLive && !taggerPreserved)) {
        return end(room, 'runner', '술래가 방을 나갔습니다');
      }
      const aliveRunners = runners.filter((p) => !isOut(p));
      if (aliveRunners.length === 0 && taggers.length > 0) {
        return end(room, 'tagger', '도망자를 모두 잡았습니다');
      }
      const downCount = runners.filter((p) => isOut(p)).length;
      if (downCount >= TAGGER_WIN_OUT_COUNT) {
        return end(room, 'tagger', `도망자 ${downCount}명 동시 다운`);
      }
      // 서버 권위 근접 잡기
      for (const tag of taggers) {
        for (const run of aliveRunners) {
          if (run.state.invulnUntil > now) continue;
          if (run.state.shieldUntil && run.state.shieldUntil > now) {
            ctx.broadcast(room, { t: 'shieldblock', id: run.id });
            continue;
          }
          if (tag.state.frozenUntil && tag.state.frozenUntil > now) continue;
          if (dist(tag.state, run.state) <= CATCH_DIST) {
            run.state.out = true;
            ctx.broadcast(room, { t: 'caught', id: run.id });
          }
        }
      }
      if (players.filter((p) => role(p) === 'runner' && !isOut(p)).length === 0) {
        return end(room, 'tagger', '도망자를 모두 잡았습니다');
      }
      // 위치/속도 동기화 (클라 보간·외삽용 vx/vz)
      const dtSec = dtMs / 1000;
      for (const p of players) {
        const st = p.state;
        st.vx = ((st.x ?? 0) - (st.prevX ?? st.x ?? 0)) / dtSec;
        st.vz = ((st.z ?? 0) - (st.prevZ ?? st.z ?? 0)) / dtSec;
        st.prevX = st.x;
        st.prevZ = st.z;
      }
      const payload = {
        t: 'peers',
        ts: now,
        list: players.map((p) => ({
          id: p.id,
          x: p.state.x ?? 0,
          z: p.state.z ?? 0,
          yaw: p.state.yaw ?? 0,
          out: isOut(p),
          role: role(p),
          invulnUntil: p.state.invulnUntil || 0,
          vx: p.state.vx || 0,
          vz: p.state.vz || 0,
          ts: now,
        })),
        score: room.state.score,
        left: Math.ceil(left),
      };
      const raw = JSON.stringify(payload);
      if (raw !== room.state.lastPeersRaw) {
        room.state.lastPeersRaw = raw;
        ctx.broadcast(room, payload);
      }
    },

    onReset: (room) => {
      room.state.score = 0;
      room.state.lastReviveAt = {};
      room.state.lastPeersRaw = undefined;
      for (const p of room.players.values()) {
        p.state.out = false;
        p.state.role = '';
        p.state.invulnUntil = 0;
        p.state.shieldUntil = 0;
        p.state.frozenUntil = 0;
        p.state.vx = 0;
        p.state.vz = 0;
        p.state.prevX = p.state.x;
        p.state.prevZ = p.state.z;
      }
    },
  };
}
