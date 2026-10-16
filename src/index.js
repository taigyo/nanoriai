import { Room } from './room.js';
export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // 部屋コード＝Durable Object名。同じコードなら同じ部屋に繋がる
      const id = env.ROOM.idFromName(m[1].toUpperCase());
      return env.ROOM.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
