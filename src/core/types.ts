import type { WebSocket } from 'ws';

/**
 * 멀티플레이 SaaS 코어 타입.
 *
 * 설계 원칙 (Colyseus의 Room 모델 + Nakama의 match handler 플러그인 모델 참고):
 * - 코어는 "게임을 모른다". 룸/좌석/세션/호스트/틱/브로드캐스트만 책임진다.
 * - 게임 규칙은 GameModule 하나로 완전히 캡슐화된다.
 * - 게임 IP(룰, 콘텐츠)는 각 게임 레포에 그대로 두고, 이 프레임워크는 재사용 가능한
 *   멀티플레이 인프라로서 독립 배포/판매 가능한 단위다.
 */

export type RoomPhase = 'lobby' | 'playing' | 'ended';

/** 접속한 플레이어 1명 (룸 소속 여부와 무관하게 소켓 단위로 존재) */
export interface Player {
  id: string;
  name: string;
  /** 게임이 자유롭게 쓰는 프로필 필드 (캐릭터, 역할 희망 등). 로비 브로드캐스트에 포함. */
  meta: Record<string, unknown>;
  ws: WebSocket | null; // null = 끊겼지만 resume 대기 중인 보존 좌석
  token: string;
  lastSeenAt: number;
  /** 게임이 자유롭게 쓰는 인게임 상태 (위치, 역할, 점수 등). 코어는 건드리지 않는다. */
  state: Record<string, any>;
}

export interface Room {
  code: string;
  /** 어떤 GameModule의 방인지 */
  gameId: string;
  hostId: string;
  phase: RoomPhase;
  players: Map<string, Player>;
  /** 호스트가 로비에서 바꾸는 설정 (맵, 모드 등). 모듈이 화이트리스트로 검증. */
  config: Record<string, any>;
  /** 게임 진행 상태. 모듈 소유. */
  state: Record<string, any>;
  createdAt: number;
  startedAt: number;
  /** 모두 끊긴 시각 (빈 방 유예용) */
  emptySince?: number;
  lastTickAt?: number;
}

/** 모듈에 제공되는 코어 API — 모듈은 이것으로만 통신한다 */
export interface CoreContext {
  send(player: Player, msg: Record<string, unknown>): void;
  /** room 전원에게 방 상태(로비) 브로드캐스트 */
  broadcastRoom(room: Room): void;
  /** room 전원에게 임의 메시지 브로드캐스트 (exceptId 제외 가능) */
  broadcast(room: Room, msg: Record<string, unknown>, exceptId?: string): void;
  /** 매치 종료 처리: end 브로드캐스트(extra 병합) → ended → resetDelayMs 후 로비 복귀 */
  endRoom(room: Room, winner: string, reason: string, extra?: Record<string, unknown>): void;
  /** 로비 플레이어 목록의 공개 형태 (모듈이 확장 가능) */
  publicPlayer(room: Room, p: Player): Record<string, unknown>;
}

export interface StartCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 게임 모듈 — 이 인터페이스 하나만 구현하면 어떤 게임이든 멀티플레이가 된다.
 * 모든 훅은 선택사항. 최소한 onStart + onMessage + onTick 정도면 실시간 게임 완성.
 */
export interface GameModule {
  /** 게임 식별자 (URL/프로토콜의 game 필드) */
  readonly id: string;
  readonly version?: string;
  readonly maxPlayers: number;
  /** 종료 후 로비 복귀까지 지연 (기본 800ms) */
  readonly resetDelayMs?: number;
  /** 룸 config/state 초기값 */
  defaults?(): { config?: Record<string, any>; state?: Record<string, any> };
  /** 로비에서 공개할 플레이어 필드 확장 */
  publicPlayer?(room: Room, p: Player): Record<string, unknown>;
  /**
   * 호스트가 로비에서 config를 바꿀 때 검증/정규화.
   * - false 반환: 거부 (반영/브로드캐스트 없음)
   * - true/undefined 반환: value를 그대로 반영
   * - 그 외 값 반환: 그 값으로 정규화해 반영
   */
  onConfigChange?(room: Room, player: Player, key: string, value: unknown): unknown;
  /** 토큰 외 수단으로 재점령 가능한 유령 좌석 찾기 (예: 닉네임 일치) */
  findReclaimable?(room: Room, player: Player): Player | null;
  onRoomCreate?(room: Room): void;
  onJoin?(room: Room, player: Player): void;
  /** 완전 이탈(resume TTL 만료 후 좌석 삭제) 시 */
  onLeave?(room: Room, player: Player): void;
  canStart?(room: Room): StartCheck;
  /** 매치 시작 — 역할 배정, 스폰, start 브로드캐스트는 모듈이 한다 */
  onStart?(room: Room): void;
  /** 코어가 처리하지 않는 모든 메시지. true 반환 시 처리됨. */
  onMessage?(room: Room, player: Player, msg: any): boolean;
  /** playing 동안 tickMs마다 호출 */
  onTick?(room: Room, dtMs: number, now: number): void;
  /** ended → lobby 리셋 시점 */
  onReset?(room: Room): void;
}

export interface ServerOptions {
  port?: number;
  path?: string;
  tickMs?: number;
  /** resume 허용 시간 (기본 5분) */
  resumeTtlMs?: number;
  /** 모두 끊긴 방 유예 (기본 60초) */
  emptyRoomGraceMs?: number;
  /** 로비 방 TTL (기본 2시간) */
  roomTtlMs?: number;
  heartbeatMs?: number;
}
