const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
require('dotenv').config();

// ==================== CONFIG ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const normalizeUsername = (username = '') => String(username || '').trim().replace(/^@+/, '').toLowerCase();
const rawAdminUsers = (process.env.ADMIN_USERNAMES || '')
    .split(/[,;\s]+/)
    .map(u => u.trim())
    .filter(Boolean);
const ADMIN_USERNAMES = rawAdminUsers
    .filter(u => !/^[0-9]+$/.test(u))
    .map(u => normalizeUsername(u));
const ADMIN_USER_IDS = [
    ...rawAdminUsers
        .filter(u => /^[0-9]+$/.test(u))
        .map(id => Number(id)),
    ...((process.env.ADMIN_USER_IDS || '')
        .split(/[,;\s]+/)
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0))
].filter((id, index, self) => Number.isInteger(id) && id > 0 && self.indexOf(id) === index);
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-app.onrender.com';
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) { console.error('ERROR: BOT_TOKEN required!'); process.exit(1); }
console.log('Admins:', ADMIN_USERNAMES);

// ==================== DATABASE ====================
async function initDatabase() {
    try {
        // initialize db adapter connection
        await db.init?.();
        if (db.DB_TYPE === 'mysql') {
            // MySQL-compatible DDL
            await db.query(`CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                photo_url TEXT,
                total_score INT DEFAULT 0,
                levels_completed INT DEFAULT 0,
                best_time INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )`);
            await db.query(`CREATE TABLE IF NOT EXISTS levels (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                image_url TEXT NOT NULL,
                dimension VARCHAR(10) NOT NULL DEFAULT '3x3',
                difficulty VARCHAR(20) DEFAULT 'medium',
                points INT DEFAULT 100,
                time_limit INT DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                order_index INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await db.query(`CREATE TABLE IF NOT EXISTS user_progress (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                level_id INT,
                completed BOOLEAN DEFAULT false,
                moves INT DEFAULT 0,
                time_taken INT DEFAULT 0,
                score INT DEFAULT 0,
                completed_at TIMESTAMP NULL,
                UNIQUE KEY user_level_unique (user_id, level_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (level_id) REFERENCES levels(id) ON DELETE CASCADE
            )`);
            await db.query(`CREATE TABLE IF NOT EXISTS leaderboard (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                total_score INT DEFAULT 0,
                levels_completed INT DEFAULT 0,
                best_time INT DEFAULT 0,
                rank INT DEFAULT 0,
                is_visible BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY user_unique (user_id)
            )`);
            await db.query(`CREATE TABLE IF NOT EXISTS admin_actions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                admin_username VARCHAR(255) NOT NULL,
                action VARCHAR(50) NOT NULL,
                target_type VARCHAR(50),
                target_id INT,
                details JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
        } else {
            // Postgres DDL (original)
            await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                username VARCHAR(255),
                first_name VARCHAR(255),
                last_name VARCHAR(255),
                photo_url TEXT,
                total_score INTEGER DEFAULT 0,
                levels_completed INTEGER DEFAULT 0,
                best_time INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS levels (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                image_url TEXT NOT NULL,
                dimension VARCHAR(10) NOT NULL DEFAULT '3x3',
                difficulty VARCHAR(20) DEFAULT 'medium',
                points INTEGER DEFAULT 100,
                time_limit INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                order_index INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS user_progress (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                level_id INTEGER REFERENCES levels(id) ON DELETE CASCADE,
                completed BOOLEAN DEFAULT false,
                moves INTEGER DEFAULT 0,
                time_taken INTEGER DEFAULT 0,
                score INTEGER DEFAULT 0,
                completed_at TIMESTAMP,
                UNIQUE(user_id, level_id)
            );
            CREATE TABLE IF NOT EXISTS leaderboard (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                total_score INTEGER DEFAULT 0,
                levels_completed INTEGER DEFAULT 0,
                best_time INTEGER DEFAULT 0,
                rank INTEGER DEFAULT 0,
                is_visible BOOLEAN DEFAULT true,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id)
            );
            CREATE TABLE IF NOT EXISTS admin_actions (
                id SERIAL PRIMARY KEY,
                admin_username VARCHAR(255) NOT NULL,
                action VARCHAR(50) NOT NULL,
                target_type VARCHAR(50),
                target_id INTEGER,
                details JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        }
        console.log('Database initialized');
    } catch (err) { console.error('DB init error:', err); }
}

// ==================== EXPRESS ====================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../web/public')));

const uploadsDir = path.join(__dirname, '../web/public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only images allowed'));
    }
});

// ==================== AUTH ====================
function verifyInitData(req, res, next) {
    const { initData } = req.body;
    if (!initData) return res.status(401).json({ error: 'No init data' });
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return res.status(401).json({ error: 'Invalid init data' });
        req.user = JSON.parse(params.get('user'));
        next();
    } catch (err) { return res.status(401).json({ error: 'Invalid init data' }); }
}

function verifyAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No auth token' });
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        const isAdmin = ADMIN_USERNAMES.includes(normalizeUsername(decoded.username)) || ADMIN_USER_IDS.includes(Number(decoded.telegramId));
        if (!isAdmin) return res.status(403).json({ error: 'Not admin' });
        req.admin = decoded;
        next();
    } catch (err) { return res.status(401).json({ error: 'Invalid token' }); }
}

// ==================== API ROUTES ====================
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/api/auth', async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'No init data' });
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return res.status(401).json({ error: 'Invalid init data' });
        const userData = JSON.parse(params.get('user'));
        const isAdmin = ADMIN_USERNAMES.includes(normalizeUsername(userData.username)) || ADMIN_USER_IDS.includes(Number(userData.id));
        const result = await db.query(
            `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (telegram_id) DO UPDATE SET
                username = EXCLUDED.username, first_name = EXCLUDED.first_name,
                last_name = EXCLUDED.last_name, photo_url = EXCLUDED.photo_url,
                updated_at = CURRENT_TIMESTAMP RETURNING *`,
            [userData.id, userData.username, userData.first_name, userData.last_name, userData.photo_url]
        );
        const user = result.rows[0];
        let token = null;
        if (isAdmin) token = jwt.sign({ userId: user.id, username: userData.username, telegramId: userData.id }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ user: { id: user.id, telegramId: userData.id, username: userData.username, firstName: userData.first_name, lastName: userData.last_name, photoUrl: userData.photo_url, isAdmin }, token });
    } catch (err) { console.error('Auth error:', err); res.status(500).json({ error: 'Auth failed' }); }
});

app.get('/api/levels', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM levels WHERE is_active = true ORDER BY order_index, id');
        res.json(result.rows || result);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/levels/:id', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM levels WHERE id = $1', [req.params.id]);
        const rows = result.rows || result;
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/progress', verifyInitData, async (req, res) => {
    try {
        const userResult = await db.query('SELECT id FROM users WHERE telegram_id = $1', [req.user.id]);
        const urows = userResult.rows || userResult;
        if (!urows || urows.length === 0) return res.status(404).json({ error: 'User not found' });
        const userId = urows[0].id;
        const result = await db.query(
            `SELECT up.*, l.name, l.image_url, l.dimension, l.points FROM user_progress up
             JOIN levels l ON up.level_id = l.id WHERE up.user_id = $1`, [userId]);
        res.json(result.rows || result);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/progress/save', verifyInitData, async (req, res) => {
    const { levelId, moves, timeTaken, score, completed } = req.body;
    try {
        const userResult = await db.query('SELECT id FROM users WHERE telegram_id = $1', [req.user.id]);
        const urows = userResult.rows || userResult;
        if (!urows || urows.length === 0) return res.status(404).json({ error: 'User not found' });
        const userId = urows[0].id;
        if (db.DB_TYPE === 'mysql') {
            await db.query(
                `INSERT INTO user_progress (user_id, level_id, completed, moves, time_taken, score, completed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON DUPLICATE KEY UPDATE
                    completed = VALUES(completed) OR completed,
                    moves = IF(VALUES(score) > score, VALUES(moves), moves),
                    time_taken = IF(VALUES(score) > score, VALUES(time_taken), time_taken),
                    score = GREATEST(VALUES(score), score),
                    completed_at = IF(VALUES(completed), VALUES(completed_at), completed_at)`,
                [userId, levelId, completed ? 1 : 0, moves, timeTaken, score, completed ? new Date() : null]
            );
        } else {
            await db.query(
                `INSERT INTO user_progress (user_id, level_id, completed, moves, time_taken, score, completed_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (user_id, level_id) DO UPDATE SET
                    completed = EXCLUDED.completed OR user_progress.completed,
                    moves = CASE WHEN EXCLUDED.score > user_progress.score THEN EXCLUDED.moves ELSE user_progress.moves END,
                    time_taken = CASE WHEN EXCLUDED.score > user_progress.score THEN EXCLUDED.time_taken ELSE user_progress.time_taken END,
                    score = GREATEST(EXCLUDED.score, user_progress.score),
                    completed_at = CASE WHEN EXCLUDED.completed THEN EXCLUDED.completed_at ELSE user_progress.completed_at END`,
                [userId, levelId, completed, moves, timeTaken, score, completed ? new Date() : null]
            );
        }
        await updateLeaderboard(userId);
        res.json({ success: true });
    } catch (err) { console.error('Save error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT l.*, u.username, u.first_name, u.last_name, u.photo_url
             FROM leaderboard l JOIN users u ON l.user_id = u.id
             WHERE l.is_visible = true ORDER BY l.total_score DESC, l.best_time ASC LIMIT 100`);
        res.json(result.rows || result);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

async function updateLeaderboard(userId) {
    try {
        let progressResult;
        if (db.DB_TYPE === 'mysql') {
            progressResult = await db.query(
                `SELECT COUNT(*) as levels_completed, IFNULL(SUM(score), 0) as total_score, IFNULL(MIN(time_taken), 0) as best_time
                 FROM user_progress WHERE user_id = $1 AND completed = true`, [userId]);
        } else {
            progressResult = await db.query(
                `SELECT COUNT(*) as levels_completed, COALESCE(SUM(score), 0) as total_score, COALESCE(MIN(time_taken), 0) as best_time
                 FROM user_progress WHERE user_id = $1 AND completed = true`, [userId]);
        }
        const pr = progressResult.rows ? progressResult.rows[0] : progressResult[0];
        const levels_completed = pr.levels_completed || 0;
        const total_score = pr.total_score || 0;
        const best_time = pr.best_time || 0;
        if (db.DB_TYPE === 'mysql') {
            await db.query(
                `INSERT INTO leaderboard (user_id, total_score, levels_completed, best_time)
                 VALUES ($1, $2, $3, $4)
                 ON DUPLICATE KEY UPDATE total_score = VALUES(total_score), levels_completed = VALUES(levels_completed), best_time = VALUES(best_time), updated_at = CURRENT_TIMESTAMP`,
                [userId, total_score, levels_completed, best_time]);
            await db.query(
                `UPDATE leaderboard l JOIN (SELECT id, ROW_NUMBER() OVER (ORDER BY total_score DESC, best_time ASC) as new_rank FROM leaderboard WHERE is_visible = true) r ON l.id = r.id SET l.rank = r.new_rank`);
        } else {
            await db.query(
                `INSERT INTO leaderboard (user_id, total_score, levels_completed, best_time)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id) DO UPDATE SET total_score = EXCLUDED.total_score, levels_completed = EXCLUDED.levels_completed, best_time = EXCLUDED.best_time, updated_at = CURRENT_TIMESTAMP`,
                [userId, total_score, levels_completed, best_time]);
            await db.query(
                `WITH ranked AS (SELECT id, ROW_NUMBER() OVER (ORDER BY total_score DESC, best_time ASC) as new_rank FROM leaderboard WHERE is_visible = true)
                 UPDATE leaderboard l SET rank = r.new_rank FROM ranked r WHERE l.id = r.id`);
        }
    } catch (err) { console.error('Leaderboard update error:', err); }
}

// ==================== ADMIN ROUTES ====================
app.post('/api/admin/login', async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'No init data' });
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return res.status(401).json({ error: 'Invalid init data' });
        const userData = JSON.parse(params.get('user'));
        const username = normalizeUsername(userData.username);
        const userId = Number(userData.id || userData.user_id || userData.telegram_id);
        console.log('[ADMIN LOGIN] userData:', { id: userData.id, username: userData.username }, 'normalized username:', username, 'ADMIN_USERNAMES:', ADMIN_USERNAMES, 'ADMIN_USER_IDS:', ADMIN_USER_IDS);
        const isAdmin = (username && ADMIN_USERNAMES.includes(username)) || ADMIN_USER_IDS.includes(userId);
        console.log('[ADMIN LOGIN] isAdmin check:', { username, userId, isAdmin, usernameMatch: username && ADMIN_USERNAMES.includes(username), idMatch: ADMIN_USER_IDS.includes(userId) });
        if (!isAdmin) return res.status(403).json({ error: 'Not admin' });
        const token = jwt.sign({ userId: userId || userData.id, username: userData.username || '', telegramId: userId || userData.id }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, username: userData.username });
    } catch (err) { console.error('[ADMIN LOGIN] Error:', err); res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/admin/levels', verifyAdmin, async (req, res) => {
    try { const result = await db.query('SELECT * FROM levels ORDER BY order_index, id'); res.json(result.rows || result); }
    catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/levels', verifyAdmin, upload.single('image'), async (req, res) => {
    const { name, description, dimension, difficulty, points, timeLimit, orderIndex } = req.body;
    try {
        if (!req.file) return res.status(400).json({ error: 'Image required' });
        const imagePath = req.file.path;
        const processedPath = path.join(uploadsDir, `processed_${req.file.filename}`);
        await sharp(imagePath).resize(600, 600, { fit: 'cover', position: 'center' }).jpeg({ quality: 85 }).toFile(processedPath);
        fs.unlinkSync(imagePath);
        const imageUrl = `/uploads/${path.basename(processedPath)}`;
        await db.query(
            `INSERT INTO levels (name, description, image_url, dimension, difficulty, points, time_limit, order_index)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [name, description, imageUrl, dimension, difficulty, points, timeLimit || 0, orderIndex || 0]);
        // fetch inserted level (fallback: match by image_url and name)
        const inserted = await db.query('SELECT * FROM levels WHERE image_url = $1 AND name = $2 ORDER BY id DESC LIMIT 1', [imageUrl, name]);
        const lvl = (inserted.rows || inserted)[0];
        await db.query('INSERT INTO admin_actions (admin_username, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
            [req.admin.username, 'CREATE_LEVEL', 'level', lvl.id, JSON.stringify({ name, dimension })]);
        res.json(lvl);
    } catch (err) { console.error('Create level error:', err); res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/levels/:id', verifyAdmin, async (req, res) => {
    const { name, description, dimension, difficulty, points, timeLimit, isActive, orderIndex } = req.body;
    try {
        await db.query(
            `UPDATE levels SET name = $1, description = $2, dimension = $3, difficulty = $4, points = $5, time_limit = $6, is_active = $7, order_index = $8 WHERE id = $9`,
            [name, description, dimension, difficulty, points, timeLimit, isActive, orderIndex, req.params.id]);
        const updated = await db.query('SELECT * FROM levels WHERE id = $1', [req.params.id]);
        const urows = updated.rows || updated;
        if (!urows || urows.length === 0) return res.status(404).json({ error: 'Not found' });
        await db.query('INSERT INTO admin_actions (admin_username, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
            [req.admin.username, 'UPDATE_LEVEL', 'level', req.params.id, JSON.stringify({ name })]);
        res.json(urows[0]);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/levels/:id', verifyAdmin, async (req, res) => {
    try {
        const levelResult = await db.query('SELECT image_url FROM levels WHERE id = $1', [req.params.id]);
        const lrows = levelResult.rows || levelResult;
        if (lrows.length > 0 && lrows[0].image_url) {
            const imagePath = path.join(__dirname, '../web/public', lrows[0].image_url);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        }
        await db.query('DELETE FROM levels WHERE id = $1', [req.params.id]);
        await db.query('INSERT INTO admin_actions (admin_username, action, target_type, target_id) VALUES ($1, $2, $3, $4)',
            [req.admin.username, 'DELETE_LEVEL', 'level', req.params.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/leaderboard', verifyAdmin, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT l.*, u.username, u.first_name, u.last_name, u.photo_url
             FROM leaderboard l JOIN users u ON l.user_id = u.id ORDER BY l.total_score DESC LIMIT 200`);
        res.json(result.rows || result);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/leaderboard/:userId/visibility', verifyAdmin, async (req, res) => {
    const { isVisible } = req.body;
    try {
        await db.query('UPDATE leaderboard SET is_visible = $1 WHERE user_id = $2', [isVisible, req.params.userId]);
        await db.query('INSERT INTO admin_actions (admin_username, action, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5)',
            [req.admin.username, 'TOGGLE_VISIBILITY', 'leaderboard', req.params.userId, JSON.stringify({ isVisible })]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/leaderboard/reset', verifyAdmin, async (req, res) => {
    try {
        await db.query('TRUNCATE TABLE user_progress');
        await db.query('TRUNCATE TABLE leaderboard');
        await db.query('INSERT INTO admin_actions (admin_username, action, target_type, details) VALUES ($1, $2, $3, $4)',
            [req.admin.username, 'RESET_LEADERBOARD', 'leaderboard', JSON.stringify({ timestamp: new Date() })]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/actions', verifyAdmin, async (req, res) => {
    try { const result = await db.query('SELECT * FROM admin_actions ORDER BY created_at DESC LIMIT 100'); res.json(result.rows || result); }
    catch (err) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT u.*, COALESCE(l.total_score, 0) as total_score, COALESCE(l.levels_completed, 0) as levels_completed
             FROM users u LEFT JOIN leaderboard l ON u.id = l.user_id ORDER BY u.created_at DESC LIMIT 500`);
        res.json(result.rows || result);
    } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
    const user = ctx.from;
    const isAdmin = ADMIN_USERNAMES.includes((user.username || '').toLowerCase());
    try {
        // upsert user compatible with Postgres and MySQL
        const existing = await db.query('SELECT id FROM users WHERE telegram_id = $1', [user.id]);
        const erows = existing.rows || existing;
        if (erows && erows.length > 0) {
            await db.query('UPDATE users SET username = $1, first_name = $2, last_name = $3, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = $4', [user.username, user.first_name, user.last_name, user.id]);
        } else {
            await db.query('INSERT INTO users (telegram_id, username, first_name, last_name) VALUES ($1, $2, $3, $4)', [user.id, user.username, user.first_name, user.last_name]);
        }
    } catch (err) { console.error('Save user error:', err); }
    const welcomeText = isAdmin
        ? `Welcome, Admin ${user.first_name}!\\n\\n🎮 Sliding Puzzle Mini App\\n\\nUse the button below to open the game or admin panel.`
        : `Welcome, ${user.first_name}!\\n\\n🎮 Sliding Puzzle Mini App\\n\\nSolve image puzzles, compete on the leaderboard, and challenge your friends!\\n\\nClick the button below to start playing.`;
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Play Game', `${WEB_APP_URL}/?user=${user.id}`)],
        ...(isAdmin ? [[Markup.button.webApp('⚙️ Admin Panel', `${WEB_APP_URL}/admin.html?user=${user.id}`)]] : [])
    ]);
    await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...keyboard });
});

bot.help((ctx) => {
    ctx.reply(`🎮 Sliding Puzzle Help\\n\\n*How to Play:*\\n1. Click Play to open the Mini App\\n2. Select a level from the list\\n3. Slide tiles to arrange the image\\n4. Complete levels to earn points!\\n\\n*Commands:*\\n/start - Start the bot\\n/play - Open the game\\n/leaderboard - View top players\\n/help - Show this help`, { parse_mode: 'Markdown' });
});

bot.command('play', async (ctx) => {
    await ctx.reply('🎮 Click the button below to start playing!',
        Markup.inlineKeyboard([Markup.button.webApp('🎮 Play Now', `${WEB_APP_URL}/?user=${ctx.from.id}`)]));
});

bot.command('leaderboard', async (ctx) => {
    try {
        const result = await db.query(
            `SELECT l.*, u.username, u.first_name, u.last_name FROM leaderboard l
             JOIN users u ON l.user_id = u.id WHERE l.is_visible = true ORDER BY l.total_score DESC LIMIT 10`);
        const rows = result.rows || result;
        if (!rows || rows.length === 0) return ctx.reply('🏆 No scores yet! Be the first to play!');
        let message = '🏆 *Top Players*\n\n';
        rows.forEach((p, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '▫️';
            const name = p.first_name || p.username || 'Anonymous';
            message += `${medal} *${i + 1}.* ${name}\n   Score: ${p.total_score} | Levels: ${p.levels_completed}\n\n`;
        });
        await ctx.reply(message, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.webApp('🎮 Play Now', `${WEB_APP_URL}/?user=${ctx.from.id}`)]) });
    } catch (err) { ctx.reply('❌ Error fetching leaderboard.'); }
});

bot.command('admin', async (ctx) => {
    const user = ctx.from;
    const isAdmin = ADMIN_USERNAMES.includes((user.username || '').toLowerCase());
    if (!isAdmin) return ctx.reply('❌ You are not authorized.');
    await ctx.reply('⚙️ *Admin Panel*\\n\\nClick below to manage levels, users, and leaderboard.',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.webApp('⚙️ Open Admin Panel', `${WEB_APP_URL}/admin.html?user=${user.id}`)]) });
});

bot.catch((err, ctx) => { console.error(`Bot error for ${ctx.updateType}:`, err); });

// ==================== START ====================
async function start() {
    await initDatabase();
    app.listen(PORT, () => { console.log(`Server on port ${PORT}`); console.log(`Web App: ${WEB_APP_URL}`); });
    bot.launch();
    console.log('Bot started');
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
start().catch(console.error);