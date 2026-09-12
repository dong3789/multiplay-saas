import { MultiplayServer } from './core/server.js';
import { createEnergyTrailModule } from './games/energy-trail/module.js';

/**
 * 엔트리포인트 — 등록할 게임 모듈을 나열한다.
 * 새 게임을 멀티플레이로 만들려면 GameModule을 구현하고 register()하면 끝.
 *
 * 프로덕션에서는 게임 모듈을 별도 npm 패키지(각 게임 레포 소유)로 배포해
 * import하는 구조를 권장 — 게임 IP는 각 레포에, 이 서버는 인프라만 유지.
 */

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

const server = new MultiplayServer([], {
  port: Number(process.env.PORT || 8791),
});

// 게임 모듈 등록 (모듈 팩토리에 CoreContext 주입)
server.register(createEnergyTrailModule(server.ctx));
// 새 게임 추가 예시:
// server.register(createMyGameModule(server.ctx));

server.listen();
