import { DurableObject } from 'cloudflare:workers';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sanitizeId(raw, maxLen = 24) {
  return (raw || '')
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, maxLen);
}

export class RelayHub extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    // Internal POST to wake a peer's inbox socket
    if (request.method === 'POST' && url.pathname === '/internal/invite') {
      const payload = await request.text();
      const sockets = this.ctx.getWebSockets('inbox');
      let delivered = 0;
      for (const ws of sockets) {
        try {
          ws.send(payload);
          delivered++;
        } catch {
          // Ignore closed sockets
        }
      }
      return new Response(JSON.stringify({ ok: true, delivered }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426, headers: CORS_HEADERS });
    }

    const mode = url.searchParams.get('mode') || 'room';
    const peer = sanitizeId(url.searchParams.get('peer'), 12);
    if (!peer) {
      return new Response('Missing peer id', { status: 400, headers: CORS_HEADERS });
    }

    if (mode === 'inbox') {
      // Close any stale inbox socket for the same peer
      for (const oldWs of this.ctx.getWebSockets('inbox')) {
        try {
          oldWs.close(1000, 'replaced');
        } catch {}
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ['inbox', `peer:${peer}`]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Room relay mode: enforce max 2 distinct peers per room
    const existingSockets = this.ctx.getWebSockets();
    const samePeerSockets = this.ctx.getWebSockets(`peer:${peer}`);
    for (const oldWs of samePeerSockets) {
      try {
        oldWs.close(1000, 'reconnected');
      } catch {}
    }

    const otherSockets = existingSockets.filter((ws) => !samePeerSockets.includes(ws));
    if (otherSockets.length >= 2) {
      return new Response('Room is full (max 2 peers)', { status: 403, headers: CORS_HEADERS });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['room', `peer:${peer}`]);

    // Notify both sides if 2 peers are now present in the room
    if (otherSockets.length >= 1) {
      const readyMsg = JSON.stringify({ type: 'relay-peer-ready', peer });
      try {
        server.send(readyMsg);
      } catch {}
      for (const other of otherSockets) {
        try {
          other.send(readyMsg);
        } catch {}
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Handle lightweight keepalive ping
    if (typeof message === 'string' && message === '{"type":"ws-ping"}') {
      try {
        ws.send('{"type":"ws-pong"}');
      } catch {}
      return;
    }

    // Pure stateless forward to the other peer in the room (zero storage)
    const sockets = this.ctx.getWebSockets('room');
    for (const other of sockets) {
      if (other !== ws) {
        try {
          other.send(message);
        } catch {}
      }
    }
  }

  async webSocketClose(ws) {
    const sockets = this.ctx.getWebSockets('room');
    const leftMsg = JSON.stringify({ type: 'relay-peer-left' });
    for (const other of sockets) {
      if (other !== ws) {
        try {
          other.send(leftMsg);
        } catch {}
      }
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011, 'socket error');
    } catch {}
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'swiftdrop-relay' }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/invite') {
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      const to = sanitizeId(body.to, 12);
      const from = sanitizeId(body.from, 12);
      const room = sanitizeId(body.room, 24);
      if (!to || !from || !room) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing fields' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }

      const stub = env.RELAY_HUB.get(env.RELAY_HUB.idFromName(`inbox:${to}`));
      const forwardReq = new Request('https://internal/internal/invite', {
        method: 'POST',
        body: JSON.stringify({ type: 'relay-invite', from, room })
      });
      return stub.fetch(forwardReq);
    }

    if (url.pathname === '/ws/inbox') {
      const peer = sanitizeId(url.searchParams.get('peer'), 12);
      if (!peer) return new Response('Missing peer', { status: 400, headers: CORS_HEADERS });
      const stub = env.RELAY_HUB.get(env.RELAY_HUB.idFromName(`inbox:${peer}`));
      const forwardUrl = new URL(request.url);
      forwardUrl.searchParams.set('mode', 'inbox');
      return stub.fetch(new Request(forwardUrl.toString(), request));
    }

    if (url.pathname === '/ws/room') {
      const room = sanitizeId(url.searchParams.get('room'), 24);
      const peer = sanitizeId(url.searchParams.get('peer'), 12);
      if (!room || !peer) return new Response('Missing room or peer', { status: 400, headers: CORS_HEADERS });
      const stub = env.RELAY_HUB.get(env.RELAY_HUB.idFromName(`room:${room}`));
      const forwardUrl = new URL(request.url);
      forwardUrl.searchParams.set('mode', 'room');
      return stub.fetch(new Request(forwardUrl.toString(), request));
    }

    return new Response('SwiftDrop E2EE Edge Relay', { status: 200, headers: CORS_HEADERS });
  }
};
