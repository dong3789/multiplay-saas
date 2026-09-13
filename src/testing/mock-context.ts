import type { CoreContext, Player, Room } from '../core/types.js';

/**
 * MockCoreContext — GameModule 단위 테스트용 기록형 mock.
 *
 * GameModule은 CoreContext로만 통신하도록 설계되어 있으므로, 이 mock 하나면
 * 서버·소켓·네트워크 없이 게임 룰을 전부 검증할 수 있다.
 *
 * 사용 예:
 *   const { ctx, sent, ended, messagesOf } = createMockContext();
 *   const mod = createEnergyTrailModule(ctx);
 *   mod.onMessage!(room, runner, { t: 'score', n: 3 });
 *   assert.equal(messagesOf('score')[0].n, 3);
 */

export interface SentRecord {
  /** 'player:<id>' | 'room:<code>' (로비 브로드캐스트) | 'broadcast:<code>' */
  to: string;
  msg: any;
  exceptId?: string;
}

export interface EndedRecord {
  winner: string;
  reason: string;
  extra?: Record<string, unknown>;
}

export function createMockContext() {
  const sent: SentRecord[] = [];
  const ended: EndedRecord[] = [];

  const ctx: CoreContext = {
    send: (player: Player, msg: Record<string, unknown>) => {
      sent.push({ to: `player:${player.id}`, msg });
    },
    broadcastRoom: (room: Room) => {
      sent.push({ to: `room:${room.code}`, msg: { t: 'room', code: room.code } });
    },
    broadcast: (room: Room, msg: Record<string, unknown>, exceptId?: string) => {
      sent.push({ to: `broadcast:${room.code}`, msg, exceptId });
    },
    endRoom: (room: Room, winner: string, reason: string, extra?: Record<string, unknown>) => {
      ended.push({ winner, reason, extra });
      room.phase = 'ended';
    },
    publicPlayer: (room: Room, p: Player) => ({
      id: p.id,
      name: p.name,
      ...p.meta,
      host: p.id === room.hostId,
    }),
  };

  return {
    ctx,
    sent,
    ended,
    /** 특정 타입 메시지만 추출 */
    messagesOf: (type: string): any[] => sent.filter((s) => s.msg?.t === type).map((s) => s.msg),
    /** 특정 플레이어에게 간 메시지만 추출 */
    messagesTo: (playerId: string): any[] =>
      sent.filter((s) => s.to === `player:${playerId}`).map((s) => s.msg),
    /** 마지막 end 기록 */
    lastEnd: (): EndedRecord | undefined => ended[ended.length - 1],
    reset: () => {
      sent.length = 0;
      ended.length = 0;
    },
  };
}

export type MockContext = ReturnType<typeof createMockContext>;
