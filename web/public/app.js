const API_URL = window.location.origin;
let tg = window.Telegram?.WebApp || null;
let currentUser = null;
let currentLevel = null;
let levels = [];
let userProgress = [];
let gameState = { board: [], emptyPos: { row: 0, col: 0 }, moves: 0, startTime: null, timerInterval: null };
let isPreviewOpen = false;

if (tg) {
    tg.ready();
    tg.expand();
    // Force the app to use the green theme regardless of Telegram's theme params
    const forcedBg = '#eef7ed';
    const forcedPrimary = '#1f8a4b';
    // update CSS variables to ensure all UI elements use the green theme
    try {
        document.documentElement.style.setProperty('--tg-theme-bg-color', forcedBg);
        document.documentElement.style.setProperty('--tg-theme-text-color', '#0f3d24');
        document.documentElement.style.setProperty('--tg-theme-hint-color', '#4f7c5d');
        document.documentElement.style.setProperty('--tg-theme-link-color', forcedPrimary);
        document.documentElement.style.setProperty('--tg-theme-button-color', forcedPrimary);
        document.documentElement.style.setProperty('--tg-theme-button-text-color', '#ffffff');
        document.documentElement.style.setProperty('--tg-theme-secondary-bg-color', '#e6f4e7');
    } catch (e) { console.warn('Could not set CSS vars:', e); }
    // Set Telegram header/background to match forced green palette
    try { tg.setHeaderColor(forcedPrimary); tg.setBackgroundColor(forcedBg); } catch (e) { /* ignore */ }
}

async function initApp() {
    // Always show menu within 5 seconds max
    const timeout = setTimeout(() => {
        console.log('[INIT] Timeout reached, showing main menu');
        showScreen('main-menu');
    }, 5000);

    const initData = tg?.initData || null;
    console.log('[INIT] Starting init, has initData:', !!initData);

    if (!initData) {
        console.log('[INIT] No initData, loading as guest');
        document.getElementById('user-name').textContent = 'Guest';
        document.getElementById('user-avatar').src = 'https://via.placeholder.com/56';
        showScreen('main-menu');
        loadLevels();
        clearTimeout(timeout);
        return;
    }

    try {
        console.log('[INIT] Authenticating user...');
        const res = await fetch(API_URL + '/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData })
        });
        
        if (!res.ok) {
            console.error('[INIT] Auth failed:', res.status);
            throw new Error('Auth failed: ' + res.status);
        }

        const data = await res.json();
        console.log('[INIT] Auth success, user:', data.user.username);
        currentUser = data.user;
        
        document.getElementById('user-name').textContent = currentUser.firstName || currentUser.username || 'Player';
        document.getElementById('user-avatar').src = currentUser.photoUrl || 'https://via.placeholder.com/56';
        
        if (currentUser.isAdmin) {
            const menuButtons = document.querySelector('.menu-buttons');
            if (menuButtons) {
                const adminBtn = document.createElement('button');
                adminBtn.className = 'btn btn-secondary';
                adminBtn.innerHTML = '<span class="material-symbols-outlined icon">settings</span> Admin Panel';
                adminBtn.onclick = () => window.location.href = '/admin.html';
                menuButtons.appendChild(adminBtn);
            }
        }

        // Show menu immediately, load data in background
        showScreen('main-menu');
        console.log('[INIT] Menu shown, loading data in background...');
        
        // Load data without blocking UI
        Promise.all([loadUserProgress(), loadLevels()])
            .then(() => {
                console.log('[INIT] Data loaded');
                updateUserStats();
                updateContinueButton();
            })
            .catch(err => console.error('[INIT] Background load error:', err));

        clearTimeout(timeout);
    } catch (err) {
        console.error('[INIT] Error:', err);
        document.getElementById('user-name').textContent = 'Guest';
        document.getElementById('user-avatar').src = 'https://via.placeholder.com/56';
        showScreen('main-menu');
        loadLevels();
        clearTimeout(timeout);
    }
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('loading'));
    const screen = document.getElementById(screenId);
    if (!screen) return;
    screen.classList.add('active');
    if (screenId === 'levels' && levels.length === 0) {
        loadLevels();
    }
    if (screenId === 'leaderboard') loadLeaderboard();
}

function updateUserStats() {
    const completed = userProgress.filter(p => p.completed).length;
    const totalScore = userProgress.reduce((sum, p) => sum + (p.score || 0), 0);
    document.getElementById('user-stats').textContent = `Score: ${totalScore} | Completed: ${completed}`;
}

async function loadLevels() {
    const grid = document.getElementById('levels-grid');
    if (grid) grid.innerHTML = '<div class="empty-state">Loading levels...</div>';
    try {
        const res = await fetch(API_URL + '/api/levels');
        levels = await res.json();
        renderLevels();
    } catch (err) {
        console.error('Load levels error:', err);
        if (grid) grid.innerHTML = '<div class="empty-state">Unable to load levels. Please try again.</div>';
    }
}

async function loadUserProgress() {
    if (!currentUser) return;
    try {
        const initData = tg?.initData || null;
        if (!initData) return;
        const res = await fetch(API_URL + '/api/progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData })
        });
        userProgress = await res.json();
    } catch (err) { console.error('Load progress error:', err); }
}

function isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const cleaned = url.trim();
    if (cleaned === '/uploads' || cleaned === '/uploads/' || cleaned === 'uploads/' || cleaned === 'uploads') return false;
    return /\.(jpe?g|png|webp|gif|bmp|svg)$/i.test(cleaned) || cleaned.startsWith('http://') || cleaned.startsWith('https://') || cleaned.startsWith('//') || cleaned.startsWith('/');
}

function getImageUrl(url) {
    if (!isValidImageUrl(url)) return 'https://via.placeholder.com/300?text=No+Image';
    const cleaned = url.trim();
    if (cleaned.startsWith('http://') || cleaned.startsWith('https://')) return cleaned;
    if (cleaned.startsWith('//')) return window.location.protocol + cleaned;
    const base = API_URL.replace(/\/$/, '');
    if (cleaned.startsWith('/')) return base + cleaned;
    if (cleaned.startsWith('uploads/')) return base + '/' + cleaned;
    return base + '/' + cleaned;
}

function getContinueLevelId() {
    // If user has an in-progress level (saved progress but not completed), continue that first
    const inProgress = userProgress.find(p => !p.completed);
    if (inProgress) return inProgress.level_id;
    // Otherwise, pick the first unlocked level that is not completed
    for (let i = 0; i < levels.length; i++) {
        const lvl = levels[i];
        const prog = userProgress.find(p => p.level_id === lvl.id);
        const prevCompleted = i === 0 ? true : (userProgress.find(p => p.level_id === levels[i - 1].id)?.completed);
        if (prevCompleted && !(prog && prog.completed)) return lvl.id;
    }
    return null;
}

function updateContinueButton() {
    const menu = document.querySelector('.menu-buttons');
    if (!menu) return;
    let btn = document.getElementById('btn-continue');
    const targetId = getContinueLevelId();
    if (!targetId) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'btn-continue';
        btn.className = 'btn btn-primary';
        menu.insertBefore(btn, menu.firstChild);
    }
    const lvl = levels.find(l => l.id === targetId);
    btn.innerHTML = `<span class="material-symbols-outlined icon">play_arrow</span> Continue: ${lvl ? lvl.name : 'Level'}`;
    btn.onclick = () => startLevel(targetId);
}

function renderLevels() {
    const grid = document.getElementById('levels-grid');
    if (!grid) return;
    if (levels.length === 0) {
        grid.innerHTML = '<div class="empty-state">No levels available yet. Please check back soon.</div>';
        return;
    }
    const difficultyOrder = ['easy', 'medium', 'hard', 'expert'];
    const difficultyLabels = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
    const grouped = difficultyOrder.map(diff => ({
        difficulty: diff,
        label: difficultyLabels[diff] || diff,
        levels: levels.filter(level => (level.difficulty || 'medium').toLowerCase() === diff)
    })).filter(group => group.levels.length > 0);

    const sections = grouped.map(group => {
        const cards = group.levels.map((level, index) => {
            const levelIndex = levels.findIndex(l => l.id === level.id);
            const progress = userProgress.find(p => p.level_id === level.id);
            const completed = progress && progress.completed;
            const isLocked = levelIndex > 0 && !userProgress.find(p => p.level_id === levels[levelIndex - 1].id && p.completed);
            const imageUrl = getImageUrl(level.image_url);
            return `
                <div class="level-card ${completed ? 'completed' : ''} ${isLocked ? 'locked' : ''}" onclick="${isLocked ? '' : `startLevel(${level.id})`}">
                    <img src="${imageUrl}" alt="${level.name}" onerror="this.src='https://via.placeholder.com/300?text=No+Image'">
                    <div class="level-card-info">
                        <h3>${level.name}</h3>
                        <p>${level.dimension} • ${level.difficulty}</p>
                        ${progress && !completed ? `<div style="margin-top:8px"><button class="btn btn-small" onclick="startLevel(${level.id})">Continue</button></div>` : ''}
                    </div>
                    <div class="level-badge ${completed ? 'completed' : ''}">${completed ? '<span class="material-symbols-outlined">check_circle</span>' : level.points + ' pts'}</div>
                </div>
            `;
        }).join('');
        return `
            <section class="difficulty-section">
                <div class="difficulty-heading">${group.label}</div>
                <div class="difficulty-grid">${cards}</div>
            </section>
        `;
    });
    grid.innerHTML = sections.join('');
}

function startLevel(levelId) {
    currentLevel = levels.find(l => String(l.id) === String(levelId));
    if (!currentLevel) return;
    document.getElementById('level-name').textContent = currentLevel.name;
    showScreen('game-screen');
    initGame(currentLevel);
}

function initGame(level) {
    const [rows, cols] = level.dimension.split('x').map(Number);
    const totalTiles = rows * cols;
    gameState.moves = 0;
    gameState.startTime = Date.now();
    gameState.board = [];
    gameState.boardImageUrl = getImageUrl(level.image_url);
    document.getElementById('move-counter').textContent = 'Moves: 0';
    document.getElementById('game-timer').innerHTML = '<span class="material-symbols-outlined">timer</span> 00:00';
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = setInterval(updateTimer, 1000);
    const board = document.getElementById('puzzle-board');
    board.innerHTML = '';
    board.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    board.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    isPreviewOpen = false;
    const previewContainer = document.getElementById('preview-image');
    if (previewContainer) previewContainer.classList.add('hidden');
    let tiles = [];
    for (let i = 0; i < totalTiles - 1; i++) tiles.push({ num: i + 1, correctPos: i });
    tiles.push({ num: 0, correctPos: totalTiles - 1 });
    do { shuffleArray(tiles); } while (!isSolvable(tiles, rows, cols) || isSolved(tiles));
    const boardImageUrl = gameState.boardImageUrl || getImageUrl(level.image_url);
    tiles.forEach((tile, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const correctRow = Math.floor(tile.correctPos / cols);
        const correctCol = tile.correctPos % cols;
        const tileEl = document.createElement('div');
        tileEl.className = 'puzzle-tile' + (tile.num === 0 ? ' empty' : '');
        if (tile.num !== 0) {
            tileEl.style.backgroundImage = `url(${boardImageUrl})`;
            tileEl.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
            tileEl.style.backgroundPosition = `${correctCol * (100 / (cols - 1))}% ${correctRow * (100 / (rows - 1))}%`;
            tileEl.innerHTML = `<span class="puzzle-tile-number">${tile.num}</span>`;
            tileEl.onclick = () => moveTile(row, col);
        }
        board.appendChild(tileEl);
        gameState.board.push({ ...tile, currentRow: row, currentCol: col, element: tileEl });
        if (tile.num === 0) gameState.emptyPos = { row, col };
    });
    const previewImage = document.getElementById('preview-img');
    if (previewImage) {
        previewImage.src = gameState.boardImageUrl;
        previewImage.onerror = () => previewImage.src = 'https://via.placeholder.com/300?text=No+Preview';
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function isSolvable(tiles, rows, cols) {
    let inversions = 0;
    const flat = tiles.map(t => t.num).filter(n => n !== 0);
    for (let i = 0; i < flat.length - 1; i++) {
        for (let j = i + 1; j < flat.length; j++) {
            if (flat[i] > flat[j]) inversions++;
        }
    }
    if (cols % 2 === 1) return inversions % 2 === 0;
    const emptyRow = Math.floor(tiles.findIndex(t => t.num === 0) / cols);
    return (inversions + emptyRow) % 2 === 1;
}

function isSolved(tiles) {
    return tiles.every((tile, i) => tile.correctPos === i);
}

function moveTile(row, col) {
    const empty = gameState.emptyPos;
    const isAdjacent = (Math.abs(row - empty.row) === 1 && col === empty.col) ||
                       (Math.abs(col - empty.col) === 1 && row === empty.row);
    if (!isAdjacent) return;
    const tileIndex = gameState.board.findIndex(t => t.currentRow === row && t.currentCol === col);
    const emptyIndex = gameState.board.findIndex(t => t.currentRow === empty.row && t.currentCol === empty.col);
    if (tileIndex === -1 || emptyIndex === -1) return;
    const tile = gameState.board[tileIndex];
    const emptyTile = gameState.board[emptyIndex];
    [tile.currentRow, emptyTile.currentRow] = [emptyTile.currentRow, tile.currentRow];
    [tile.currentCol, emptyTile.currentCol] = [emptyTile.currentCol, tile.currentCol];
    gameState.emptyPos = { row, col };
    gameState.moves++;
    document.getElementById('move-counter').textContent = 'Moves: ' + gameState.moves;
    renderBoard();
    if (checkWin()) handleWin();
}

function renderBoard() {
    const board = document.getElementById('puzzle-board');
    board.innerHTML = '';
    const [rows, cols] = currentLevel.dimension.split('x').map(Number);
    const sorted = [...gameState.board].sort((a, b) => {
        if (a.currentRow !== b.currentRow) return a.currentRow - b.currentRow;
        return a.currentCol - b.currentCol;
    });
    sorted.forEach(tile => {
        const correctRow = Math.floor(tile.correctPos / cols);
        const correctCol = tile.correctPos % cols;
        const isCorrect = tile.currentRow === correctRow && tile.currentCol === correctCol;
        const tileEl = document.createElement('div');
        tileEl.className = 'puzzle-tile' + (tile.num === 0 ? ' empty' : '') + (isCorrect && tile.num !== 0 ? ' correct' : '');
        if (tile.num !== 0) {
            tileEl.style.backgroundImage = `url(${gameState.boardImageUrl || getImageUrl(currentLevel.image_url)})`;
            tileEl.style.backgroundSize = `${cols * 100}% ${rows * 100}%`;
            tileEl.style.backgroundPosition = `${correctCol * (100 / (cols - 1))}% ${correctRow * (100 / (rows - 1))}%`;
            tileEl.innerHTML = `<span class="puzzle-tile-number">${tile.num}</span>`;
            tileEl.onclick = () => moveTile(tile.currentRow, tile.currentCol);
        }
        board.appendChild(tileEl);
    });
}

function checkWin() {
    return gameState.board.every(tile => {
        const correctRow = Math.floor(tile.correctPos / currentLevel.dimension.split('x').map(Number)[1]);
        const correctCol = tile.correctPos % currentLevel.dimension.split('x').map(Number)[1];
        return tile.currentRow === correctRow && tile.currentCol === correctCol;
    });
}

function handleWin() {
    clearInterval(gameState.timerInterval);
    const timeTaken = Math.floor((Date.now() - gameState.startTime) / 1000);
    const [rows, cols] = currentLevel.dimension.split('x').map(Number);
    const totalTiles = rows * cols;
    const baseScore = currentLevel.points;
    const timeBonus = Math.max(0, 300 - timeTaken);
    const moveBonus = Math.max(0, totalTiles * 3 - gameState.moves);
    const score = Math.floor(baseScore + timeBonus + moveBonus);
    document.getElementById('complete-time').textContent = formatTime(timeTaken);
    document.getElementById('complete-moves').textContent = gameState.moves;
    document.getElementById('complete-score').textContent = score;
    document.getElementById('level-complete').classList.remove('hidden');
    if (currentUser) saveProgress(currentLevel.id, gameState.moves, timeTaken, score, true);
    tg?.HapticFeedback?.notificationOccurred?.('success');
}

async function saveProgress(levelId, moves, timeTaken, score, completed) {
    try {
        const initData = tg?.initData || null;
        if (!initData) return;
        await fetch(API_URL + '/api/progress/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData, levelId, moves, timeTaken, score, completed })
        });
        await loadUserProgress();
        updateUserStats();
    } catch (err) { console.error('Save progress error:', err); }
}

function nextLevel() {
    document.getElementById('level-complete').classList.add('hidden');
    const currentIndex = levels.findIndex(l => l.id === currentLevel.id);
    if (currentIndex < levels.length - 1) {
        startLevel(levels[currentIndex + 1].id);
    } else {
        showScreen('main-menu');
        tg?.showAlert?.('Congratulations! You completed all levels!');
    }
}

function closeLevelComplete() {
    const modal = document.getElementById('level-complete');
    if (modal) modal.classList.add('hidden');
}

function quitGame() {
    clearInterval(gameState.timerInterval);
    showScreen('main-menu');
}

function updateTimer() {
    const elapsed = Math.floor((Date.now() - gameState.startTime) / 1000);
    document.getElementById('game-timer').innerHTML = '<span class="material-symbols-outlined">timer</span> ' + formatTime(elapsed);
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
    const secs = (seconds % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

function togglePreview() {
    isPreviewOpen = !isPreviewOpen;
    document.getElementById('preview-image').classList.toggle('hidden', !isPreviewOpen);
}

function shuffleBoard() {
    const [rows, cols] = currentLevel.dimension.split('x').map(Number);
    const totalTiles = rows * cols;
    let tiles = gameState.board.map(t => ({ num: t.num, correctPos: t.correctPos }));
    do { shuffleArray(tiles); } while (!isSolvable(tiles, rows, cols) || isSolved(tiles));
    tiles.forEach((tile, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const boardTile = gameState.board.find(t => t.num === tile.num);
        boardTile.currentRow = row;
        boardTile.currentCol = col;
        if (tile.num === 0) gameState.emptyPos = { row, col };
    });
    renderBoard();
}

function resetGame() {
    if (!currentLevel) return;
    // Preserve existing DOM tiles and image sizing.
    // Reset counters and timer, then reshuffle the board in-place.
    clearInterval(gameState.timerInterval);
    gameState.moves = 0;
    gameState.startTime = Date.now();
    document.getElementById('move-counter').textContent = 'Moves: 0';
    document.getElementById('game-timer').innerHTML = '<span class="material-symbols-outlined">timer</span> 00:00';
    // Shuffle existing board positions without rebuilding tile elements
    shuffleBoard();
    // Restart timer
    clearInterval(gameState.timerInterval);
    gameState.timerInterval = setInterval(updateTimer, 1000);
}

async function loadLeaderboard() {
    try {
        const res = await fetch(API_URL + '/api/leaderboard');
        const data = await res.json();
        const list = document.getElementById('leaderboard-list');
        if (data.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tg-theme-hint-color,#999)">No scores yet. Be the first!</div>';
            return;
        }
        list.innerHTML = data.map((player, i) => {
            const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
            const medal = i === 0 ? '<span class="material-symbols-outlined">emoji_events</span>' : i === 1 ? '<span class="material-symbols-outlined">military_tech</span>' : i === 2 ? '<span class="material-symbols-outlined">military_tech</span>' : (i + 1);
            return `
                <div class="leaderboard-item">
                    <div class="leaderboard-rank ${rankClass}">${medal}</div>
                    <img class="leaderboard-avatar" src="${player.photo_url || 'https://via.placeholder.com/44'}" alt="${player.first_name || 'Player'}">
                    <div class="leaderboard-info">
                        <h4>${player.first_name || player.username || 'Anonymous'}</h4>
                        <p>${player.levels_completed} levels completed</p>
                    </div>
                    <div class="leaderboard-score">
                        <div class="score">${player.total_score}</div>
                        <div class="levels">pts</div>
                    </div>
                </div>
            `;
        }).join('');
    } catch (err) { console.error('Leaderboard error:', err); }
}

initApp();