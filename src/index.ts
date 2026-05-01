import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { WebSocketServer, WebSocket } from 'ws';
import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';
import recipesRoutes from './routes/recipes';
import commentsRoutes from './routes/comments';
import kudosRoutes from './routes/kudos';
import usersRoutes from './routes/users';
import notificationsRoutes from './routes/notifications';
import { createMessagesRouter } from './routes/messages';
import { runMigrations } from './db/migrate';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/posts', postsRoutes);
app.use('/posts/:postId/comments', commentsRoutes);
app.use('/posts/:postId/kudos', kudosRoutes);
app.use('/recipes', recipesRoutes);
app.use('/users', usersRoutes);
app.use('/notifications', notificationsRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

// ─── WebSocket server ─────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// convId → connected sockets in that room
const convRooms = new Map<string, Set<WebSocket>>();
// userId → all connected sockets for that user
const userConns = new Map<string, Set<WebSocket>>();

function sendTo(ws: WebSocket, event: string, data: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

export function emitToUser(userId: string, event: string, data: unknown) {
  userConns.get(userId)?.forEach(ws => sendTo(ws, event, data));
}

export function emitToConversation(convId: string, event: string, data: unknown) {
  convRooms.get(convId)?.forEach(ws => sendTo(ws, event, data));
}

wss.on('connection', (ws) => {
  let userId: string | null = null;
  const joinedRooms = new Set<string>();

  ws.on('message', (raw) => {
    try {
      const { event, data } = JSON.parse(raw.toString()) as { event: string; data: any };

      if (event === 'auth') {
        try {
          const payload = jwt.verify(data.token, process.env.JWT_SECRET!) as { userId: string };
          userId = payload.userId;
          if (!userConns.has(userId)) userConns.set(userId, new Set());
          userConns.get(userId)!.add(ws);
          // Notify others this user is online
          wss.clients.forEach(c => {
            if (c !== ws) sendTo(c, 'user_online', { userId });
          });
        } catch {
          ws.close(4001, 'Invalid token');
        }
        return;
      }

      if (!userId) return;

      if (event === 'join') {
        const convId: string = data.convId;
        if (!convRooms.has(convId)) convRooms.set(convId, new Set());
        convRooms.get(convId)!.add(ws);
        joinedRooms.add(convId);
      }

      if (event === 'leave') {
        const convId: string = data.convId;
        convRooms.get(convId)?.delete(ws);
        joinedRooms.delete(convId);
      }

      if (event === 'typing') {
        const { convId, typing } = data as { convId: string; typing: boolean };
        convRooms.get(convId)?.forEach(c => {
          if (c !== ws) sendTo(c, 'typing', { userId, convId, typing });
        });
      }
    } catch {}
  });

  ws.on('close', () => {
    if (userId) {
      userConns.get(userId)?.delete(ws);
      if (!userConns.get(userId)?.size) {
        userConns.delete(userId);
        wss.clients.forEach(c => sendTo(c, 'user_offline', { userId }));
      }
    }
    joinedRooms.forEach(convId => convRooms.get(convId)?.delete(ws));
  });
});

// Mount messages routes
app.use('/messages', createMessagesRouter(emitToUser));

const PORT = process.env.PORT ?? 3000;

runMigrations()
  .then(() => server.listen(PORT, () => console.log(`FoodShare API running on port ${PORT}`)))
  .catch(err => {
    console.error('[boot] migration failed, exiting', err);
    process.exit(1);
  });
