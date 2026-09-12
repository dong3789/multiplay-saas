import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  CoreContext,
  GameModule,
  Player,
  Room,
  ServerOptions,
} from './types.js';

interface Session {
  playerId: string;
  roomCode: string;
  expiresAt: number;
}

interface Slot {
  player: Player;
  room: Room | null;
}

/**
 * MultiplayServer — 게임을 모르는 범용 멀티플레이 코어.
 *
 * 코어가 책임지는 것 (어떤 게임이든 동일):
 * - WebSocket 연결/하트비트/좀비 소켓 정리
 * - 세션 토큰 발급 + 끊김 후 resume (같은 좌석/호스트 권한 복원)
 * - 방 코드 생성, create/join/leave, 인원 제한, 유령 좌석 재점령
 * - 호스트 권한 + 호스트 승계
 * - lobby → playing → ended → lobby 페이즈 머신
 * - 룸 TTL / 빈 방 유예 / 틱 루프
 *
 * 코어가 모르는 것 (GameModule 소유):
 * - 역할, 점수, 아이템, 판정 등 모든 게임 규칙
 */
export class MultiplayServer {
  private readonly modules = new Map<string, GameModule>();
  private readonly rooms = new Map<string, Room>();
  private readonly sockets = new Map<WebSocket, Slot>();
  private readonly sessions = new Map<string, Session>();
  private readonly opts: Required<ServerOptions>;
  private httpServer!: HttpServer;
  private wss!: WebSocketServer;
  private timers: NodeJS.Timeout[] = [];

  readonly ctx: CoreContext;

  constructor(modules: GameModule[], options: ServerOptions = {}) {
    for (const m of modules) this.modules.set(m.id, m);
    this.opts = {
      port: options.port ?? 8791,
      path: options.path ?? '/ws',
      tickMs: options.tickMs ?? 80,
      resumeTtlMs: options.resumeTtlMs ?? 5 * 60 * 1000,
      emptyRoomGraceMs: options.emptyRoomGraceMs ?? 60 * 1000,
      roomTtlMs: options.roomTtlMs ?? 2 * 60 * 60 * 1000,
      heartbeatMs: options.heartbeatMs ?? 30_000,
    };
    this.ctx = {
      send: (player, msg) => this.send(player.ws, msg),
      broadcastRoom: (room) => this.broadcastRoom(room),
      broadcast: (room, msg, exceptId) => this.broadcast(room, msg, exceptId),
      endRoom: (room, winner, reason, extra) => this.endRoom(room, winner, reason, extra),
      publicPlayer: (room, p) => this.publicPlayer(room, p),
    };
  }

  /** 게임 모듈 등록 — listen 전후 모두 가능 */
  register(module: GameModule): void {
    this.modules.set(module.id, module);
  }

  // ---------- lifecycle ----------

  listen(): void {
    this.httpServer = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            rooms: this.rooms.size,
            connections: this.sockets.size,
            games: [...this.modules.keys()],
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('multiplay-saas');
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: this.opts.path });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    this.timers.push(setInterval(() => this.tickAll(), this.opts.tickMs));
    this.timers.push(setInterval(() => this.heartbeat(), this.opts.heartbeatMs));

    this.httpServer.listen(this.opts.port, '0.0.0.0', () => {
      console.log(
        `[multiplay-saas] :${this.opts.port}${this.opts.path} games=[${[...this.modules.keys()].join(', ')}]`,
      );
    });
  }

  close(): void {
    for (const t of this.timers) clearInterval(t);
    this.wss?.close();
    this.httpServer?.close();
  }

  // ---------- connection ----------

  private onConnection(ws: WebSocket & { isAlive?: boolean }) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const player: Player = {
      id: `p_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      name: '손님',
      meta: {},
      ws,
      token: `s_${randomUUID().replace(/-/g, '')}`,
      lastSeenAt: Date.now(),
      state: {},
    };
    this.sockets.set(ws, { player, room: null });
    this.send(ws, { t: 'welcome', id: player.id, token: player.token });

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        this.onMessage(ws, msg);
      } catch (err) {
        console.error('[message]', err);
      }
    });
    ws.on('close', () => this.onDisconnect(ws));
    ws.on('error', () => this.onDisconnect(ws));
  }

  private onDisconnect(ws: WebSocket) {
    const slot = this.sockets.get(ws);
    if (!slot) return;
    this.sockets.delete(ws);
    const { player, room } = slot;
    if (!room) return;
    // 즉시 삭제 대신 세션 보존 — 같은 토큰으로 resume하면 같은 좌석/호스트로 복귀
    player.ws = null;
    player.lastSeenAt = Date.now();
    this.sessions.set(player.token, {
      playerId: player.id,
      roomCode: room.code,
      expiresAt: player.lastSeenAt + this.opts.resumeTtlMs,
    });
    if ([...room.players.values()].some((p) => p.ws !== null)) {
      room.emptySince = undefined;
      this.broadcastRoom(room);
      return;
    }
    if (room.emptySince === undefined) room.emptySince = Date.now();
  }

  // ---------- message routing ----------

  private onMessage(ws: WebSocket, msg: any) {
    const slot = this.sockets.get(ws);
    if (!slot) return;
    const player = slot.player;
    const { t } = msg;

    // --- 코어 프로토콜 (모든 게임 공통) ---
    if (t === 'hello') {
      if (typeof msg.name === 'string' && msg.name.trim())
        player.name = msg.name.trim().slice(0, 12);
      if (msg.meta && typeof msg.meta === 'object') Object.assign(player.meta, msg.meta);
      if (slot.room) this.broadcastRoom(slot.room);
      return;
    }
    if (t === 'resume') return this.handleResume(ws, slot, msg);
    if (t === 'create') return this.handleCreate(slot, msg);
    if (t === 'join') return this.handleJoin(ws, slot, msg);

    const room = slot.room;
    if (!room) return;
    const mod = this.modules.get(room.gameId);
    if (!mod) return;

    if (t === 'leave') {
      room.players.delete(player.id);
      this.sessions.delete(player.token);
      slot.room = null;
      if (player.id === room.hostId) room.hostId = [...room.players.keys()][0] ?? '';
      mod.onLeave?.(room, player);
      this.broadcastRoom(room);
      return;
    }
    if (t === 'config' && room.hostId === player.id && room.phase === 'lobby') {
      const key = String(msg.key || '').slice(0, 24);
      if (!key) return;
      const result = mod.onConfigChange?.(room, player, key, msg.value);
      if (result === false) return; // 모듈이 거부
      room.config[key] = result === true || result === undefined ? msg.value : result;
      this.broadcastRoom(room);
      return;
    }
    if (t === 'start' && room.hostId === player.id && room.phase !== 'playing') {
      const check = mod.canStart?.(room) ?? { ok: true };
      if (!check.ok) {
        this.send(ws, { t: 'err', msg: check.reason ?? '시작할 수 없어요.' });
        return;
      }
      // 유령 좌석은 매치에서 제외
      for (const p of [...room.players.values()]) {
        if (p.ws !== null) continue;
        room.players.delete(p.id);
        this.sessions.delete(p.token);
        if (p.id === room.hostId) room.hostId = player.id;
      }
      room.phase = 'playing';
      room.startedAt = Date.now();
      room.lastTickAt = undefined;
      mod.onStart?.(room);
      return;
    }

    // --- 게임 메시지는 모듈로 ---
    mod.onMessage?.(room, player, msg);
  }

  private handleResume(ws: WebSocket, slot: Slot, msg: any) {
    if (slot.room) return;
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 40) : '';
    const session = this.lookupSession(token);
    const room = session ? this.rooms.get(session.roomCode) : null;
    const seat = room?.players.get(session!.playerId);
    if (!session || !room || !seat || seat.ws !== null) {
      if (token) this.sessions.delete(token);
      this.send(ws, { t: 'resumeDenied' });
      return;
    }
    this.attachSeat(ws, slot, seat, room, token);
  }

  private handleCreate(slot: Slot, msg: any) {
    if (slot.room) return;
    const gameId = String(msg.game || '');
    const mod = this.modules.get(gameId);
    if (!mod) {
      this.send(slot.player.ws, { t: 'err', msg: `알 수 없는 게임: ${gameId}` });
      return;
    }
    const code = this.genCode();
    if (!code) {
      this.send(slot.player.ws, { t: 'err', msg: '서버가 가득 찼어요. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    const defaults = mod.defaults?.() ?? {};
    const room: Room = {
      code,
      gameId,
      hostId: slot.player.id,
      phase: 'lobby',
      players: new Map([[slot.player.id, slot.player]]),
      config: { ...(defaults.config ?? {}), ...(msg.config ?? {}) },
      state: defaults.state ?? {},
      createdAt: Date.now(),
      startedAt: 0,
    };
    this.rooms.set(code, room);
    slot.room = room;
    mod.onRoomCreate?.(room);
    this.sendRoom(slot.player.ws, room, slot.player.id);
  }

  private handleJoin(ws: WebSocket, slot: Slot, msg: any) {
    const code = String(msg.code || '').replace(/\D/g, '').slice(0, 4);
    const room = this.rooms.get(code);
    const player = slot.player;
    if (!room) {
      this.send(ws, { t: 'err', msg: '대기 중인 방을 찾지 못했어요.' });
      return;
    }
    if (slot.room === room) {
      this.sendRoom(ws, room, player.id);
      return;
    }
    const mod = this.modules.get(room.gameId)!;

    // 1) 토큰 기반 유령 좌석 재점령
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 40) : '';
    const session = this.lookupSession(token);
    const bySession =
      session && session.roomCode === code ? room.players.get(session.playerId) : undefined;
    const byToken = token
      ? [...room.players.values()].find((p) => p.token === token)
      : undefined;
    if (byToken && byToken.ws && byToken.ws !== ws) {
      this.send(ws, { t: 'err', msg: '이미 이 방에 들어와 있어요.' });
      return;
    }
    let ghost =
      (bySession && bySession.ws === null ? bySession : null) ??
      (byToken && byToken.ws === null ? byToken : null);
    // 2) 모듈 제공 수단 (닉네임 등)으로 재점령
    if (!ghost) ghost = mod.findReclaimable?.(room, player) ?? null;
    if (ghost) {
      ghost.name = player.name;
      ghost.meta = { ...ghost.meta, ...player.meta };
      this.attachSeat(ws, slot, ghost, room, token || ghost.token);
      return;
    }

    if (room.phase === 'playing') {
      this.send(ws, { t: 'err', msg: '이미 게임이 진행 중인 방이에요.' });
      return;
    }
    const liveSeats = [...room.players.values()].filter((p) => p.ws !== null).length;
    if (liveSeats >= mod.maxPlayers) {
      this.send(ws, { t: 'err', msg: '방이 가득 찼어요.' });
      return;
    }
    room.players.set(player.id, player);
    slot.room = room;
    mod.onJoin?.(room, player);
    this.broadcastRoom(room);
  }

  // ---------- tick / cleanup ----------

  private tickAll() {
    const now = Date.now();
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(token);
    }
    for (const [code, room] of this.rooms) {
      const mod = this.modules.get(room.gameId);
      if (!mod) {
        this.rooms.delete(code);
        continue;
      }
      // 빈 방 유예 종료
      if (room.emptySince !== undefined && now - room.emptySince > this.opts.resumeTtlMs) {
        if (room.phase === 'playing') {
          room.emptySince = undefined;
        } else {
          this.rooms.delete(code);
          continue;
        }
      }
      // resume TTL 지난 끊긴 좌석 정리 (호스트 승계 포함)
      let removed = false;
      for (const p of [...room.players.values()]) {
        if (p.ws === null && now - p.lastSeenAt > this.opts.resumeTtlMs) {
          room.players.delete(p.id);
          this.sessions.delete(p.token);
          if (p.id === room.hostId) room.hostId = [...room.players.keys()][0] ?? '';
          mod.onLeave?.(room, p);
          removed = true;
        }
      }
      if (room.players.size === 0) {
        this.rooms.delete(code);
        continue;
      }
      if (removed) this.broadcastRoom(room);
      // 로비 TTL
      if (now - room.createdAt > this.opts.roomTtlMs && room.phase === 'lobby') {
        this.rooms.delete(code);
        continue;
      }
      if (room.phase === 'playing') {
        const dtMs = room.lastTickAt ? Math.max(1, now - room.lastTickAt) : this.opts.tickMs;
        try {
          mod.onTick?.(room, dtMs, now);
        } catch (err) {
          console.error('[tick] room', code, 'threw:', err);
        }
        room.lastTickAt = now;
      }
    }
  }

  private heartbeat() {
    for (const ws of this.wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  // ---------- phase helpers ----------

  private endRoom(room: Room, winner: string, reason: string, extra?: Record<string, unknown>) {
    if (room.phase !== 'playing') return;
    const mod = this.modules.get(room.gameId);
    room.phase = 'ended';
    this.broadcast(room, { t: 'end', winner, reason, ...extra });
    const delay = mod?.resetDelayMs ?? 800;
    setTimeout(() => {
      if (!this.rooms.has(room.code) || room.phase !== 'ended') return;
      room.phase = 'lobby';
      room.startedAt = 0;
      mod?.onReset?.(room);
      this.broadcastRoom(room);
    }, delay);
  }

  // ---------- send helpers ----------

  private send(ws: WebSocket | null, msg: Record<string, unknown>) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  private broadcast(room: Room, msg: Record<string, unknown>, exceptId = '') {
    const raw = JSON.stringify(msg);
    for (const p of room.players.values()) {
      if (p.id === exceptId) continue;
      if (p.ws && p.ws.readyState === 1) p.ws.send(raw);
    }
  }

  private publicPlayer(room: Room, p: Player): Record<string, unknown> {
    const mod = this.modules.get(room.gameId);
    return {
      id: p.id,
      name: p.name,
      ...p.meta,
      host: p.id === room.hostId,
      ...(mod?.publicPlayer?.(room, p) ?? {}),
    };
  }

  private roomPayload(room: Room) {
    return {
      t: 'room' as const,
      code: room.code,
      game: room.gameId,
      hostId: room.hostId,
      phase: room.phase,
      config: room.config,
      players: [...room.players.values()].map((p) => this.publicPlayer(room, p)),
    };
  }

  private sendRoom(ws: WebSocket | null, room: Room, playerId: string) {
    this.send(ws, { ...this.roomPayload(room), selfId: playerId });
  }

  private broadcastRoom(room: Room) {
    const base = this.roomPayload(room);
    for (const p of room.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ ...base, selfId: p.id }));
    }
  }

  private attachSeat(ws: WebSocket, slot: Slot, seat: Player, room: Room, token: string) {
    this.sessions.delete(token);
    seat.ws = ws;
    seat.token = token;
    seat.lastSeenAt = Date.now();
    slot.player = seat;
    slot.room = room;
    this.send(ws, { t: 'welcome', id: seat.id, token });
    this.sendRoom(ws, room, seat.id);
    this.broadcastRoom(room);
  }

  private lookupSession(token: string): Session | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s || s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }

  private genCode(): string {
    for (let i = 0; i < 20; i++) {
      const c = String(1000 + Math.floor(Math.random() * 9000));
      if (!this.rooms.has(c)) return c;
    }
    for (let c = 1000; c < 10000; c++) {
      if (!this.rooms.has(String(c))) return String(c);
    }
    return '';
  }
}
