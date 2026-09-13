import type { GameModule, Player, Room } from '../core/types.js';

/**
 * 테스트 픽스처 — Room/Player를 소켓 없이 만든다.
 *
 * ws 필드 주의: 게임 룰은 `p.ws !== null`로 "연결됨"을 판정하므로
 * connected: true(기본)면 더미 객체를 넣는다. null이면 resume 대기 유령 좌석.
 */

let seq = 0;

export interface PlayerOptions extends Partial<Player> {
  /** false면 ws=null (끊긴 보존 좌석). 기본 true */
  connected?: boolean;
}

export function makePlayer(options: PlayerOptions = {}): Player {
  seq++;
  const { connected = true, ...overrides } = options;
  return {
    id: `p_test${seq}`,
    name: `테스터${seq}`,
    meta: {},
    ws: connected ? ({} as any) : null,
    token: `s_test${seq}`,
    lastSeenAt: Date.now(),
    state: {},
    ...overrides,
  };
}

export interface RoomOptions {
  code?: string;
  players?: Player[];
  config?: Record<string, any>;
  state?: Record<string, any>;
  phase?: Room['phase'];
  hostId?: string;
  startedAt?: number;
}

/** 모듈의 defaults()를 반영한 방을 만든다 (playing 시작 전 로비 상태) */
export function makeRoom(mod: GameModule, options: RoomOptions = {}): Room {
  const defaults = mod.defaults?.() ?? {};
  const players = options.players ?? [];
  const room: Room = {
    code: options.code ?? '9999',
    gameId: mod.id,
    hostId: options.hostId ?? players[0]?.id ?? '',
    phase: options.phase ?? 'lobby',
    players: new Map(players.map((p) => [p.id, p])),
    config: { ...(defaults.config ?? {}), ...(options.config ?? {}) },
    state: { ...(defaults.state ?? {}), ...(options.state ?? {}) },
    createdAt: Date.now(),
    startedAt: options.startedAt ?? 0,
  };
  return room;
}

/** onStart까지 실행해 playing 상태의 방을 만든다 */
export function makeStartedRoom(
  mod: GameModule,
  players: Player[],
  options: RoomOptions = {},
): Room {
  const room = makeRoom(mod, { ...options, players });
  room.phase = 'playing';
  room.startedAt = options.startedAt ?? Date.now();
  mod.onStart?.(room);
  return room;
}

/** 특정 역할의 플레이어를 찾는다 */
export function byRole(room: Room, role: 'tagger' | 'runner'): Player[] {
  return [...room.players.values()].filter((p) => p.state.role === role);
}
