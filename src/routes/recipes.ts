import { Router, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { upload } from '../middleware/upload';
import { AuthRequest } from '../types';

const router = Router();

// GET /recipes — own recipes only
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.title, r.description, r.image_url, r.prep_time, r.cook_time,
              r.servings, r.difficulty, r.tags, r.created_at,
              u.id AS user_id, u.name AS user_name, u.avatar_url
       FROM recipes r
       JOIN users u ON u.id = r.user_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC`,
      [req.userId]
    );
    res.json({ recipes: rows });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /recipes/:id — full recipe with ingredients + steps
router.get('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.title, r.description, r.image_url, r.prep_time, r.cook_time,
              r.servings, r.difficulty, r.tags, r.utensils, r.created_at,
              u.id AS user_id, u.name AS user_name, u.avatar_url
       FROM recipes r
       JOIN users u ON u.id = r.user_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) { res.status(404).json({ error: 'Recipe not found' }); return; }

    const [{ rows: ingredients }, { rows: steps }] = await Promise.all([
      pool.query(
        'SELECT id, name, amount, unit FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY position',
        [req.params.id]
      ),
      pool.query(
        'SELECT id, text FROM recipe_steps WHERE recipe_id = $1 ORDER BY position',
        [req.params.id]
      ),
    ]);

    res.json({ recipe: { ...rows[0], ingredients, steps } });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /recipes — create recipe with optional image
router.post('/', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response) => {
  const file = req.file as any;
  const {
    title, description, prep_time, cook_time, servings, difficulty,
    tags, utensils, ingredients, steps,
  } = req.body as {
    title: string; description?: string; prep_time?: string; cook_time?: string;
    servings?: string; difficulty?: string; tags?: string; utensils?: string;
    ingredients?: string; steps?: string;
  };
  if (!title) { res.status(400).json({ error: 'title is required' }); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO recipes (user_id, title, description, image_url, prep_time, cook_time, servings, difficulty, tags, utensils)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        req.userId, title, description ?? null, file?.path ?? null,
        prep_time ? parseInt(prep_time) : null,
        cook_time ? parseInt(cook_time) : null,
        servings ? parseInt(servings) : null,
        difficulty ?? null,
        tags ? JSON.parse(tags) : null,
        utensils ? JSON.parse(utensils) : null,
      ]
    );
    const recipeId = rows[0].id;

    const parsedIngredients: { name: string; amount: string; unit: string }[] = ingredients ? JSON.parse(ingredients) : [];
    const parsedSteps: { text: string }[] = steps ? JSON.parse(steps) : [];

    for (let i = 0; i < parsedIngredients.length; i++) {
      const ing = parsedIngredients[i];
      await client.query(
        'INSERT INTO recipe_ingredients (recipe_id, name, amount, unit, position) VALUES ($1,$2,$3,$4,$5)',
        [recipeId, ing.name, ing.amount, ing.unit, i]
      );
    }
    for (let i = 0; i < parsedSteps.length; i++) {
      await client.query(
        'INSERT INTO recipe_steps (recipe_id, text, position) VALUES ($1,$2,$3)',
        [recipeId, parsedSteps[i].text, i]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ recipeId });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// PATCH /recipes/:id — update recipe
router.patch('/:id', requireAuth, upload.single('image'), async (req: AuthRequest, res: Response) => {
  const file = req.file as any;
  const {
    title, description, prep_time, cook_time, servings, difficulty,
    tags, utensils, ingredients, steps,
  } = req.body as {
    title?: string; description?: string; prep_time?: string; cook_time?: string;
    servings?: string; difficulty?: string; tags?: string; utensils?: string;
    ingredients?: string; steps?: string;
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT id FROM recipes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!existing[0]) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Recipe not found or unauthorized' });
      return;
    }

    const sets: string[] = [];
    const vals: any[] = [];
    let n = 1;
    if (title !== undefined) { sets.push(`title = $${n++}`); vals.push(title); }
    if (description !== undefined) { sets.push(`description = $${n++}`); vals.push(description || null); }
    if (prep_time !== undefined) { sets.push(`prep_time = $${n++}`); vals.push(prep_time ? parseInt(prep_time) : null); }
    if (cook_time !== undefined) { sets.push(`cook_time = $${n++}`); vals.push(cook_time ? parseInt(cook_time) : null); }
    if (servings !== undefined) { sets.push(`servings = $${n++}`); vals.push(servings ? parseInt(servings) : null); }
    if (difficulty !== undefined) { sets.push(`difficulty = $${n++}`); vals.push(difficulty || null); }
    if (tags !== undefined) { sets.push(`tags = $${n++}`); vals.push(tags ? JSON.parse(tags) : null); }
    if (utensils !== undefined) { sets.push(`utensils = $${n++}`); vals.push(utensils ? JSON.parse(utensils) : null); }
    if (file?.path) { sets.push(`image_url = $${n++}`); vals.push(file.path); }
    if (sets.length > 0) {
      vals.push(req.params.id);
      await client.query(`UPDATE recipes SET ${sets.join(', ')} WHERE id = $${n}`, vals);
    }

    if (ingredients !== undefined) {
      await client.query('DELETE FROM recipe_ingredients WHERE recipe_id = $1', [req.params.id]);
      const parsed: { name: string; amount: string; unit: string }[] = JSON.parse(ingredients);
      for (let i = 0; i < parsed.length; i++) {
        await client.query(
          'INSERT INTO recipe_ingredients (recipe_id, name, amount, unit, position) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, parsed[i].name, parsed[i].amount, parsed[i].unit, i]
        );
      }
    }

    if (steps !== undefined) {
      await client.query('DELETE FROM recipe_steps WHERE recipe_id = $1', [req.params.id]);
      const parsed: { text: string }[] = JSON.parse(steps);
      for (let i = 0; i < parsed.length; i++) {
        await client.query(
          'INSERT INTO recipe_steps (recipe_id, text, position) VALUES ($1,$2,$3)',
          [req.params.id, parsed[i].text, i]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// DELETE /recipes/:id
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM recipes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Recipe not found or unauthorized' }); return; }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
