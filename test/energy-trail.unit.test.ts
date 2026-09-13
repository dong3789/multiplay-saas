/**
 * energy-trail GameModule 단위 테스트 — MockCoreContext로 서버 없이 룰 검증.
 * 통합 테스트(smoke/et-compat)가 "연결"을 검증한다면, 이 파일은 "규칙"을 검증한다.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyTrailModule } from '../src/games/energy-trail/module.js';
import { createMockContext, type MockContext } from '../src/testing/mock-context.js';
import { makePlayer, makeRoom, makeStartedRoom, byRole } from '../src/testing/fixtures.js';
import type { GameModule, Player, Room } from '../src/core/types.js';

let mock: MockContext;
let mod: GameModule;

beforeEach(() => {
  mock = createMockContext();
  mod = createEnergyTrailModule(mock.ctx);
});

/** 술래 1 + 도망자 2의 표준 매치를 만든다 */
function standardMatch() {
  const tagger = makePlayer({ name: '술래', meta: { wish: 'tagger' } });
  const r1 = makePlayer({ name: '도망1', meta: { wish: 'runner' } });
  const r2 = makePlayer({ name: '도망2', meta: { wish: 'runner' } });
  const room = makeStartedRoom(mod, [tagger, r1, r2]);
  return { room, tagger, r1, r2 };
}

describe('onStart — 역할 배정과 스폰', () => {
  it('tagger 희망자가 술래가 되고 start 브로드캐스트에 역할/맵/모드가 담긴다', () => {
    const { room, tagger, r1, r2 } = standardMatch();
    assert.equal(tagger.state.role, 'tagger');
    assert.equal(r1.state.role, 'runner');
    assert.equal(r2.state.role, 'runner');
    const start = mock.messagesOf('start')[0];
    assert.equal(start.roles[tagger.id], 'tagger');
    assert.equal(start.map, 'park');
    assert.equal(start.mode, 'items');
    assert.ok(start.spawns[tagger.id]);
    assert.equal(room.state.score, 0);
  });

  it('스폰 위치가 설정되고 속도는 0으로 초기화된다', () => {
    const { tagger } = standardMatch();
    assert.equal(tagger.state.x, 12);
    assert.equal(tagger.state.z, 12);
    assert.equal(tagger.state.vx, 0);
  });
});

describe('score — 자국 점수', () => {
  it('runner만 점수를 올릴 수 있고 goal 도달 시 runner 승', () => {
    const { room, tagger, r1 } = standardMatch();
    mod.onMessage!(room, tagger, { t: 'score', n: 5 }); // 술래의 점수는 무시
    assert.equal(room.state.score, 0);
    mod.onMessage!(room, r1, { t: 'score', n: 8 });
    assert.equal(room.state.score, 8);
    assert.equal(mock.lastEnd()?.winner, 'runner');
    assert.equal(mock.lastEnd()?.extra?.score, 8);
  });

  it('레이트 리밋: 250ms 안의 연타는 무시된다', () => {
    const { room, r1 } = standardMatch();
    mod.onMessage!(room, r1, { t: 'score', n: 2 });
    mod.onMessage!(room, r1, { t: 'score', n: 2 }); // 즉시 연타 → 무시
    assert.equal(room.state.score, 2);
  });

  it('한 메시지당 최대 10점으로 클램프된다', () => {
    const { room, r1 } = standardMatch();
    mod.onMessage!(room, r1, { t: 'score', n: 999 });
    assert.equal(room.state.score, 10); // 999 → 10 클램프
    assert.equal(mock.lastEnd()?.winner, 'runner'); // goal 8 초과로 종료
  });
});

describe('catch — 잡기 판정', () => {
  it('근접한 runner를 잡으면 caught 브로드캐스트', () => {
    const { room, tagger, r1 } = standardMatch();
    tagger.state.x = 0; tagger.state.z = 0;
    r1.state.x = 1; r1.state.z = 0;
    mod.onMessage!(room, tagger, { t: 'catch', id: r1.id });
    assert.equal(r1.state.out, true);
    assert.equal(mock.messagesOf('caught')[0].id, r1.id);
  });

  it('방어막이 있으면 shieldblock으로 차단된다', () => {
    const { room, tagger, r1 } = standardMatch();
    tagger.state.x = 0; tagger.state.z = 0;
    r1.state.x = 1; r1.state.z = 0;
    r1.state.shieldUntil = Date.now() + 5000;
    mod.onMessage!(room, tagger, { t: 'catch', id: r1.id });
    assert.equal(r1.state.out, false);
    assert.equal(mock.messagesOf('shieldblock')[0].id, r1.id);
  });

  it('얼어있는 술래는 잡을 수 없다', () => {
    const { room, tagger, r1 } = standardMatch();
    tagger.state.x = 0; tagger.state.z = 0;
    r1.state.x = 1; r1.state.z = 0;
    tagger.state.frozenUntil = Date.now() + 2000;
    mod.onMessage!(room, tagger, { t: 'catch', id: r1.id });
    assert.equal(r1.state.out, false);
  });
});

describe('use — 아이템', () => {
  it('classic 모드에서는 아이템 사용이 무시된다', () => {
    const { room, r1 } = standardMatch();
    room.config.mode = 'classic';
    mod.onMessage!(room, r1, { t: 'use', kind: 'dash' });
    assert.equal(mock.messagesOf('use').length, 0);
  });

  it('화이트리스트에 없는 kind는 무시된다', () => {
    const { room, r1 } = standardMatch();
    mod.onMessage!(room, r1, { t: 'use', kind: 'nuke' });
    assert.equal(mock.messagesOf('use').length, 0);
  });

  it('shield는 서버 권위로 shieldUntil을 설정한다', () => {
    const { room, r1 } = standardMatch();
    const before = Date.now();
    mod.onMessage!(room, r1, { t: 'use', kind: 'shield' });
    assert.ok(r1.state.shieldUntil >= before + 8000);
  });
});

describe('ice — 술래 얼리기', () => {
  it('범위 안이면 술래가 얼고 쿨다운이 걸린다', () => {
    const { room, tagger, r1 } = standardMatch();
    tagger.state.x = 0; tagger.state.z = 0;
    r1.state.x = 5; r1.state.z = 0; // ICE_RANGE 8 이내
    mod.onMessage!(room, r1, { t: 'ice' });
    assert.ok(tagger.state.frozenUntil > Date.now());
    const frozenAt = tagger.state.frozenUntil;
    mod.onMessage!(room, r1, { t: 'ice' }); // 쿨다운 중 재시도
    assert.equal(tagger.state.frozenUntil, frozenAt);
  });

  it('범위 밖이면 얼리기 실패', () => {
    const { room, tagger, r1 } = standardMatch();
    tagger.state.x = 0; tagger.state.z = 0;
    r1.state.x = 20; r1.state.z = 0;
    mod.onMessage!(room, r1, { t: 'ice' });
    assert.equal(tagger.state.frozenUntil, 0);
  });
});

describe('revive — 동료 살리기', () => {
  function downedMatch() {
    const m = standardMatch();
    m.r2.state.out = true;
    m.room.state.score = 5;
    return m;
  }

  it('정상 살리기: 자국 3개 차감 + 가장자리 부활 + 무적 + 쿨다운 기록', () => {
    const { room, r1, r2 } = downedMatch();
    r1.state.x = 0; r1.state.z = 0;
    r2.state.x = 1; r2.state.z = 0;
    mod.onMessage!(room, r1, { t: 'revive', id: r2.id });
    assert.equal(room.state.score, 2); // 5 - 3
    assert.equal(r2.state.out, false);
    assert.ok(r2.state.invulnUntil > Date.now());
    assert.ok(room.state.lastReviveAt[r2.id] > 0);
    const revived = mock.messagesOf('revived')[0];
    assert.equal(revived.id, r2.id);
    // 가장자리 스폰: 맵 중앙이 아님
    assert.ok(Math.abs(revived.x) > 10 || Math.abs(revived.z) > 10);
  });

  it('자국 부족 시 not_enough_trail', () => {
    const { room, r1, r2 } = downedMatch();
    room.state.score = 2;
    r1.state.x = 0; r1.state.z = 0;
    r2.state.x = 1; r2.state.z = 0;
    mod.onMessage!(room, r1, { t: 'revive', id: r2.id });
    assert.equal(mock.messagesTo(r1.id)[0].reason, 'not_enough_trail');
    assert.equal(r2.state.out, true);
  });

  it('거리 초과 시 target_too_far', () => {
    const { room, r1, r2 } = downedMatch();
    r1.state.x = 0; r1.state.z = 0;
    r2.state.x = 20; r2.state.z = 0;
    mod.onMessage!(room, r1, { t: 'revive', id: r2.id });
    assert.equal(mock.messagesTo(r1.id)[0].reason, 'target_too_far');
  });

  it('쿨다운 중 재살리기는 cooldown', () => {
    const { room, r1, r2 } = downedMatch();
    r1.state.x = 0; r1.state.z = 0;
    r2.state.x = 1; r2.state.z = 0;
    room.state.lastReviveAt[r2.id] = Date.now() - 1000; // 1초 전 살림 (8초 쿨다운)
    mod.onMessage!(room, r1, { t: 'revive', id: r2.id });
    assert.equal(mock.messagesTo(r1.id)[0].reason, 'cooldown');
  });

  it('종료 10초 전에는 too_late', () => {
    const { room, r1, r2 } = downedMatch();
    room.startedAt = Date.now() - 70_000; // 남은 5초
    r1.state.x = 0; r1.state.z = 0;
    r2.state.x = 1; r2.state.z = 0;
    mod.onMessage!(room, r1, { t: 'revive', id: r2.id });
    assert.equal(mock.messagesTo(r1.id)[0].reason, 'too_late');
  });
});

describe('onTick — 승패 판정과 동기화', () => {
  it('시간 만료 시 tagger 승', () => {
    const { room } = standardMatch();
    room.startedAt = Date.now() - 76_000;
    mod.onTick!(room, 80, Date.now());
    assert.equal(mock.lastEnd()?.winner, 'tagger');
  });

  it('도망자 2명 동시 다운 시 tagger 승', () => {
    const { room, r1, r2 } = standardMatch();
    r1.state.out = true;
    r2.state.out = true;
    mod.onTick!(room, 80, Date.now());
    assert.equal(mock.lastEnd()?.winner, 'tagger');
  });

  it('술래 좌석이 완전히 사라지면 runner 승', () => {
    const { room, tagger } = standardMatch();
    room.players.delete(tagger.id); // 이탈로 좌석 자체가 정리된 상태
    mod.onTick!(room, 80, Date.now());
    assert.equal(mock.lastEnd()?.winner, 'runner');
  });

  it('술래가 끊겨도 좌석이 보존 중이면 종료를 유보한다', () => {
    const { room, tagger } = standardMatch();
    tagger.ws = null; // resume 대기 유령 좌석
    mod.onTick!(room, 80, Date.now());
    assert.equal(mock.ended.length, 0);
  });

  it('peers 브로드캐스트에 위치/속도/무적 정보가 담긴다', () => {
    const { room, r1 } = standardMatch();
    r1.state.x = 5; r1.state.z = 3;
    r1.state.prevX = 4; r1.state.prevZ = 3;
    mod.onTick!(room, 1000, Date.now()); // dt 1초 → vx = 1 m/s
    const peers = mock.messagesOf('peers')[0];
    const row = peers.list.find((p: any) => p.id === r1.id);
    assert.equal(row.x, 5);
    assert.equal(row.vx, 1);
    assert.ok('invulnUntil' in row);
    assert.equal(typeof peers.left, 'number');
  });
});

describe('onConfigChange — 로비 설정', () => {
  it('mode는 classic/items로 정규화된다', () => {
    const room = makeRoom(mod, { players: [makePlayer()] });
    assert.equal(mod.onConfigChange!(room, room.players.values().next().value!, 'mode', 'classic'), 'classic');
    assert.equal(mod.onConfigChange!(room, room.players.values().next().value!, 'mode', 'weird'), 'items');
  });

  it('허용되지 않은 키는 거부(false)', () => {
    const room = makeRoom(mod, { players: [makePlayer()] });
    const host = room.players.values().next().value!;
    assert.equal(mod.onConfigChange!(room, host, 'maxScore', 999), false);
  });
});

describe('findReclaimable — 닉네임 유령 좌석 재점령', () => {
  it('끊긴 좌석 중 닉네임이 유일하면 재점령 허용', () => {
    const ghost = makePlayer({ name: '유령', connected: false });
    const room = makeRoom(mod, { players: [ghost, makePlayer({ name: '생존' })] });
    const incoming = makePlayer({ name: '유령' });
    assert.equal(mod.findReclaimable!(room, incoming)?.id, ghost.id);
  });

  it('같은 닉네임이 2명이면 재점령 불가 (사칭 방지)', () => {
    const g1 = makePlayer({ name: '중복', connected: false });
    const g2 = makePlayer({ name: '중복' });
    const room = makeRoom(mod, { players: [g1, g2] });
    const incoming = makePlayer({ name: '중복' });
    assert.equal(mod.findReclaimable!(room, incoming), null);
  });
});
