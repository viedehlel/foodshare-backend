import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import postsRoutes from './routes/posts';
import recipesRoutes from './routes/recipes';
import commentsRoutes from './routes/comments';
import kudosRoutes from './routes/kudos';
import usersRoutes from './routes/users';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/posts', postsRoutes);
app.use('/posts/:postId/comments', commentsRoutes);
app.use('/posts/:postId/kudos', kudosRoutes);
app.use('/recipes', recipesRoutes);
app.use('/users', usersRoutes);

app.get('/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`FoodShare API running on port ${PORT}`));
