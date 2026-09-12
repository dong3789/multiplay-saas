/**
 * MultiplayClient — 브라우저/Node 공용 경량 클라이언트 SDK.
 *
 * 어떤 게임 클라이언트든 이 SDK 하나로 멀티플레이에 붙는다:
 * - 자동 재연결 + 세션 토큰 resume (모바일 네트워크 전환 대응)
 * - 방 만들기/참가/호스트 시작/설정 변경
 * - 게임 메시지 송수신 (send / on)
 *
 * 사용 예:
 *   const mp = new MultiplayClient('wss://example.com/ws');
 *   await mp.connect();
 *   mp.on('peers', (m) => render(m.list));
 *   const room = await mp.create('energy-trail');
 *   mp.send({ t: 'pos', x: 1, z: 2, yaw: 0 });
 */

type Handler = (msg: any) => void;

export interface RoomState {
  code: string;
  game: string;
  hostId: string;
  phase: 'lobby' | 'playing' | 'ended';
  config: Record<string, any>;
  players: Array<Record<string, any>>;
  selfId: string;
}

export class MultiplayClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private room: RoomState | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  playerId = '';
  token = '';

  constructor(
    private readonly url: string,
    private readonly opts: { autoReconnect?: boolean; storage?: Storage } = {},
  ) {
    this.token = this.opts.storage?.getItem('mp_token') ?? '';
  }

  get currentRoom(): RoomState | null {
    return this.room;
  }

  get isHost(): boolean {
    return !!this.room && this.room.hostId === this.playerId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        // 이전 세션이 있으면 resume 시도
        if (this.token) this.send({ t: 'resume', token: this.token });
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.playerId = msg.id;
          this.token = msg.token;
          this.opts.storage?.setItem('mp_token', this.token);
          resolve();
        }
        if (msg.t === 'room') this.room = msg as RoomState;
        if (msg.t === 'resumeDenied') {
          this.token = '';
          this.opts.storage?.removeItem('mp_token');
          this.room = null;
        }
        this.emit(msg.t, msg);
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      ws.onclose = () => {
        this.emit('disconnect', {});
        if (!this.manualClose && this.opts.autoReconnect !== false) {
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(() => {});
          }, 1500);
        }
      };
    });
  }

  hello(name: string, meta: Record<string, unknown> = {}) {
    this.send({ t: 'hello', name, meta });
  }

  create(game: string, config: Record<string, any> = {}) {
    this.send({ t: 'create', game, config });
  }

  join(code: string) {
    this.send({ t: 'join', code, token: this.token });
  }

  leave() {
    this.send({ t: 'leave' });
    this.room = null;
  }

  setConfig(key: string, value: unknown) {
    this.send({ t: 'config', key, value });
  }

  start() {
    this.send({ t: 'start' });
  }

  send(msg: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  on(type: string, fn: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  private emit(type: string, msg: any) {
    for (const fn of this.handlers.get(type) ?? []) fn(msg);
    for (const fn of this.handlers.get('*') ?? []) fn(msg);
  }

  disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
