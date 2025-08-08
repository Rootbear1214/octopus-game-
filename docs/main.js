// Octopus Game - Red Light, Green Light
// Implementation per README: 50 players (1 human WASD), AI players, solid collisions,
// start/finish dashed lines, red/green border bar toggling every 2-5s.

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  const uiLight = document.getElementById('lightStatus');
  const uiRound = document.getElementById('roundStatus');
  const uiTimer = document.getElementById('timer');

  // Visual + world constants
  const MARGIN = 28;
  const START_INSET = 80; // distance from field.left to start line
  const FINISH_INSET = 80; // distance from field.right to finish line
  const BORDER_WIDTH = 16; // red/green bar thickness

  const NUM_PLAYERS = 50;
  const RADIUS = 9;
  const HUMAN_INDEX = 0;
  const HUMAN_COLOR = '#0c5c2e';
  const AI_COLOR = '#0b4d27';
  const DEAD_COLOR = '#555';

  const HUMAN_SPEED = 150; // px/s
  const AI_BASE_SPEED_MIN = 110;
  const AI_BASE_SPEED_MAX = 160;

  const RED_GREEN_MIN = 2.0; // seconds
  const RED_GREEN_MAX = 5.0; // seconds
  const MOVE_EPS = 0.35; // pixels, anything above while red is a shot
  const WARNING_MS = 900; // pre-red warning duration
  const PANICKER_DEATH_THRESHOLD = 5; // after this many AIs die, panickers are removed
  const GAME_DURATION_MS = 25 * 1000; // 25 second game timer

  const field = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

  function resizeCanvas() {
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale drawing to CSS pixels

    field.left = MARGIN + BORDER_WIDTH * 0.5;
    field.top = MARGIN + BORDER_WIDTH * 0.5;
    field.right = w - (MARGIN + BORDER_WIDTH * 0.5);
    field.bottom = h - (MARGIN + BORDER_WIDTH * 0.5);
    field.width = field.right - field.left;
    field.height = field.bottom - field.top;

    startX = field.left + START_INSET;
    finishX = field.right - FINISH_INSET;
  }

  let startX = 0;
  let finishX = 0;

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Light controller
  let isGreen = true;
  let isWarning = false; // true in the short period before turning red
  let lastSwitchAt = performance.now();
  let nextSwitchAt = lastSwitchAt + randRange(RED_GREEN_MIN, RED_GREEN_MAX) * 1000;
  let warnAt = nextSwitchAt - WARNING_MS; // only used when currently green
  let redStartAt = 0;
  let panicTriggered = false; // set after the first shot
  let panickersCulled = false; // true once we kill the panic group
  let gameStartAt = performance.now();
  let timeRemainingMs = GAME_DURATION_MS;
  let timeUpTriggered = false; // mass elimination already executed

  function toggleLight() {
    isGreen = !isGreen;
    lastSwitchAt = performance.now();
    nextSwitchAt = lastSwitchAt + randRange(RED_GREEN_MIN, RED_GREEN_MAX) * 1000;
    if (!isGreen) {
      // entering red
      redStartAt = lastSwitchAt;
      isWarning = false;
      // On red start, schedule AI mistakes and set grace period
      for (const p of players) {
        if (!p.alive || p.finished) continue;
        if (p.isAI) {
          p.willTwitchThisRed = Math.random() < p.mistakeRate;
          p.twitchedThisRed = false;
          p.redForgivenUntil = redStartAt + p.reactionDelay;
        } else {
          // No grace for human
          p.redForgivenUntil = redStartAt;
        }
      }
    } else {
      // entering green -> schedule next warning time
      warnAt = nextSwitchAt - WARNING_MS;
    }
  }

  // Input
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (['KeyW','KeyA','KeyS','KeyD'].includes(e.code)) {
      keys.add(e.code);
      e.preventDefault();
    }
  }, { passive: false });
  window.addEventListener('keyup', (e) => {
    if (['KeyW','KeyA','KeyS','KeyD'].includes(e.code)) {
      keys.delete(e.code);
      e.preventDefault();
    }
  }, { passive: false });

  // Players
  /** @typedef {{id:number,x:number,y:number,px:number,py:number, r:number, color:string, outline?:string, vx:number, vy:number, speed:number, alive:boolean, finished:boolean, isAI:boolean, isMoving:boolean, reactionDelay:number, mistakeRate:number, sideBias:number, willTwitchThisRed:boolean, twitchedThisRed:boolean, redForgivenUntil:number, isPanicRunner:boolean, immuneToRed:boolean, panicDirX:number, panicDirY:number, panicDirUntil:number, bloodDots:any[]}} Player */
  /** @type {Player[]} */
  const players = [];

  function spawnPlayers() {
    players.length = 0;
    // Arrange in compact grid behind start line
    const usableLeft = field.left + 20;
    const usableRight = startX - 8;
    const usableTop = field.top + 20;
    const usableBottom = field.bottom - 20;

    const cols = Math.max(1, Math.floor((usableRight - usableLeft) / (RADIUS * 2.6)));
    const rows = Math.max(1, Math.floor((usableBottom - usableTop) / (RADIUS * 2.6)));

    let i = 0;
    for (let row = 0; row < rows && i < NUM_PLAYERS; row++) {
      for (let col = 0; col < cols && i < NUM_PLAYERS; col++) {
        const x = usableLeft + (col + 0.5) * (RADIUS * 2.6);
        const y = usableTop + (row + 0.5) * (RADIUS * 2.6);
        const p = createAIPlayer(i, x + Math.random()*2-1, y + Math.random()*2-1);
        if (i === HUMAN_INDEX) {
          p.isAI = false;
          p.color = HUMAN_COLOR;
          p.outline = '#ffffff';
          p.speed = HUMAN_SPEED;
        }
        players.push(p);
        i++;
      }
    }
  }

  function createAIPlayer(id, x, y) {
    const speed = randRange(AI_BASE_SPEED_MIN, AI_BASE_SPEED_MAX);
    // Slightly longer grace window and lower mistake rate -> "only some" die
    const reactionDelay = randRange(120, 260); // ms grace on red start
    const mistakeRate = randRange(0.02, 0.06); // chance per red to twitch
    const sideBias = Math.random() < 0.5 ? -1 : 1; // prefer drifting up or down to avoid traffic
    return {
      id, x, y, px: x, py: y,
      r: RADIUS,
      color: AI_COLOR,
      vx: 0, vy: 0,
      speed,
      alive: true,
      finished: false,
      isAI: true,
      isMoving: false,
      reactionDelay,
      mistakeRate,
      sideBias,
      willTwitchThisRed: false,
      twitchedThisRed: false,
      redForgivenUntil: 0,
      isPanicRunner: false,
      immuneToRed: false,
      panicDirX: 0,
      panicDirY: 0,
      panicDirUntil: 0,
      bloodDots: [],
    };
  }

  function clampToField(p) {
    p.x = Math.max(field.left + p.r, Math.min(field.right - p.r, p.x));
    p.y = Math.max(field.top + p.r, Math.min(field.bottom - p.r, p.y));
  }

  function wantDirForAI(p, now) {
    // Move mostly to the right; avoid crowding ahead; slight vertical drift
    let dx = 1;
    let dy = 0.12 * p.sideBias;

    // Avoid nearby player directly ahead within a cone
    const AHEAD_DIST = RADIUS * 3.5;
    const AVOID_PUSH = 0.7;
    for (const q of players) {
      if (q === p || !q.alive || q.finished) continue;
      const dxq = q.x - p.x;
      const dyq = q.y - p.y;
      if (dxq > 0 && Math.abs(dyq) < AHEAD_DIST && dxq < AHEAD_DIST) {
        dy += (dyq > 0 ? -1 : 1) * AVOID_PUSH * (1 - dxq / AHEAD_DIST);
      }
    }

    // Slight noise
    dy += (Math.random() - 0.5) * 0.06;

    // Normalize
    const len = Math.hypot(dx, dy) || 1;
    return { dx: dx / len, dy: dy / len };
  }

  function updateHuman(p, dt) {
    if (!p.alive || p.finished) return;
    let dx = 0, dy = 0;
    if (keys.has('KeyW')) dy -= 1;
    if (keys.has('KeyS')) dy += 1;
    if (keys.has('KeyA')) dx -= 1;
    if (keys.has('KeyD')) dx += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      if (!isGreen) {
        // Any attempted movement on red -> shot
        markShot(p);
      } else {
        p.x += dx * p.speed * dt;
        p.y += dy * p.speed * dt;
        p.isMoving = true;
      }
    } else {
      p.isMoving = false;
    }
  }

  function updateAI(p, dt, now) {
    if (!p.alive || p.finished) return;

    // Panic runners ignore red and roam quickly pushing others
    if (p.isPanicRunner) {
      if (now > p.panicDirUntil) {
        // pick a new random unit direction
        let dx = Math.random() * 2 - 1;
        let dy = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy) || 1;
        p.panicDirX = dx / len;
        p.panicDirY = dy / len;
        p.panicDirUntil = now + randRange(500, 1200);
      }
      // Bounce off walls
      if (p.x <= field.left + p.r + 2 || p.x >= field.right - p.r - 2) p.panicDirX *= -1;
      if (p.y <= field.top + p.r + 2 || p.y >= field.bottom - p.r - 2) p.panicDirY *= -1;

      p.x += p.panicDirX * p.speed * dt * 1.0;
      p.y += p.panicDirY * p.speed * dt * 1.0;
      p.isMoving = true;
      return;
    }

    if (isGreen) {
      const { dx, dy } = wantDirForAI(p, now);
      p.x += dx * p.speed * dt;
      p.y += dy * p.speed * dt;
      p.isMoving = true;
    } else {
      // During red: some will keep moving for their reaction delay, others might twitch
      const sinceRed = now - redStartAt;
      let moved = false;

      if (sinceRed < p.reactionDelay) {
        const { dx, dy } = wantDirForAI(p, now);
        p.x += dx * p.speed * dt * 0.9;
        p.y += dy * p.speed * dt * 0.9;
        moved = true;
      } else if (p.willTwitchThisRed && !p.twitchedThisRed && Math.random() < 0.02) {
        // brief accidental twitch
        const { dx, dy } = wantDirForAI(p, now);
        p.x += dx * p.speed * dt * 0.6;
        p.y += dy * p.speed * dt * 0.6;
        moved = true;
        p.twitchedThisRed = true;
      }

      p.isMoving = moved;
    }
  }

  function markShot(p, opts = {}) {
    if (!p.alive || p.finished) return;
    p.alive = false;
    p.isMoving = false;
    p.deathAt = performance.now();
    // Store last position for rendering effect
    p.px = p.x; p.py = p.y;
    // Generate random red dot pattern for this corpse
    p.bloodDots = makeBloodDots(p);

    // Trigger panic group once on first death
    if (!panicTriggered && !opts.suppressPanic) {
      panicTriggered = true;
      const candidates = players.filter(q => q.alive && !q.finished && q.isAI && q !== p);
      // Choose a small group
      const groupSize = Math.min(candidates.length, Math.floor(randRange(4, 8)));
      shuffleInPlace(candidates);
      const now = performance.now();
      for (let i = 0; i < groupSize; i++) {
        const r = candidates[i];
        r.isPanicRunner = true;
        r.immuneToRed = true; // they can move on red without being shot
        r.speed = Math.max(r.speed, 220);
        // initialize random direction
        let dx = Math.random() * 2 - 1;
        let dy = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy) || 1;
        r.panicDirX = dx / len; r.panicDirY = dy / len;
        r.panicDirUntil = now + randRange(500, 1200);
      }
    }
  }

  function postMoveCollisionAndRules(now) {
    // Boundary clamp first
    for (const p of players) {
      if (!p.alive) continue;
      clampToField(p);
    }

    // Separate overlaps. Prefer moving players to be displaced.
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 0; i < players.length; i++) {
        const a = players[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < players.length; j++) {
          const b = players[j];
          if (!b.alive) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy) || 0.0001;
          const minDist = a.r + b.r + 0.1;
          if (dist < minDist) {
            const overlap = (minDist - dist);
            const nx = dx / dist, ny = dy / dist;
            // Decide who to move: if one is moving and the other isn't, move the mover more
            let moveA = 0.5, moveB = 0.5;
            if (a.isMoving && !b.isMoving) { moveA = 1; moveB = 0; }
            else if (!a.isMoving && b.isMoving) { moveA = 0; moveB = 1; }
            // Panic runner pushes others more regardless
            if (a.isPanicRunner && !b.isPanicRunner) { moveA = 0.1; moveB = 0.9; }
            else if (!a.isPanicRunner && b.isPanicRunner) { moveA = 0.9; moveB = 0.1; }
            a.x -= nx * overlap * moveA;
            a.y -= ny * overlap * moveA;
            b.x += nx * overlap * moveB;
            b.y += ny * overlap * moveB;

            clampToField(a);
            clampToField(b);
          }
        }
      }
    }

    // Finish line check and red movement elimination
    for (const p of players) {
      if (!p.alive || p.finished) continue;
      if (p.x >= finishX) {
        p.finished = true;
        p.isMoving = false;
        continue;
      }
      // Movement while red is punished (after grace window)
      const movedDist = Math.hypot(p.x - p.px, p.y - p.py);
      if (!isGreen && !p.immuneToRed && now > (p.redForgivenUntil || redStartAt) && movedDist > MOVE_EPS) {
        markShot(p);
      }
      // Store last position for next frame check
      p.px = p.x; p.py = p.y;
    }

    // If enough AIs have died, eliminate panic runners
    if (panicTriggered && !panickersCulled) {
      const deadAI = players.reduce((acc, q) => acc + ((q.isAI && !q.alive) ? 1 : 0), 0);
      if (deadAI >= PANICKER_DEATH_THRESHOLD) {
        for (const q of players) {
          if (q.isPanicRunner && q.alive) {
            markShot(q);
          }
        }
        panickersCulled = true;
      }
    }
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Background sand
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f6e7a8';
    ctx.fillRect(0, 0, w, h);

    // Border bar (green/yellow/red)
    const tSince = performance.now() - lastSwitchAt;
    const transitionMs = 220; // quick fade
    let col;
    if (isWarning) {
      // flashing yellow during warning
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.02);
      col = mixColor('#e1b12c', '#f4d03f', pulse);
    } else if (tSince < transitionMs) {
      const a = Math.min(1, tSince / transitionMs);
      col = isGreen ? mixColor('#a91d3a', '#1eb854', a) : mixColor('#1eb854', '#a91d3a', a);
    } else {
      col = isGreen ? '#1eb854' : '#a91d3a';
    }
    ctx.lineWidth = BORDER_WIDTH;
    ctx.strokeStyle = col;
    ctx.strokeRect(field.left - BORDER_WIDTH*0.5, field.top - BORDER_WIDTH*0.5,
                   field.width + BORDER_WIDTH, field.height + BORDER_WIDTH);

    // Start and finish dashed lines
    ctx.save();
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#444';
    // start
    ctx.beginPath();
    ctx.moveTo(startX, field.top + 6);
    ctx.lineTo(startX, field.bottom - 6);
    ctx.stroke();
    // finish
    ctx.beginPath();
    ctx.moveTo(finishX, field.top + 6);
    ctx.lineTo(finishX, field.bottom - 6);
    ctx.stroke();
    ctx.restore();

    // Players
    for (const p of players) {
      if (p.finished) {
        // draw with gold outline
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 2, 0, Math.PI*2);
        ctx.fillStyle = '#ffdd55';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      ctx.fillStyle = p.alive ? p.color : DEAD_COLOR;
      ctx.fill();
      if (!p.isAI) {
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = p.outline || '#fff';
        ctx.stroke();
      }
      if (!p.alive) {
        // draw random-position small red dots generated at death
        ctx.save();
        ctx.fillStyle = '#e53935';
        const dots = p.bloodDots || [];
        for (const d of dots) {
          ctx.beginPath();
          ctx.arc(p.x + d.dx, p.y + d.dy, d.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  function mixColor(aHex, bHex, t) {
    const a = hexToRgb(aHex);
    const b = hexToRgb(bHex);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    return `rgb(${r},${g},${bl})`;
  }
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
  }

  function randRange(min, max) { return min + Math.random() * (max - min); }
  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
  function makeBloodDots(p) {
    const dots = [];
    const count = Math.floor(randRange(4, 9));
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const dist = p.r * randRange(0.1, 0.7);
      const dx = Math.cos(theta) * dist;
      const dy = Math.sin(theta) * dist;
      const r = Math.max(1.2, p.r * randRange(0.16, 0.3));
      dots.push({ dx, dy, r });
    }
    return dots;
  }

  function updateUILight() {
    uiLight.textContent = `Light: ${isWarning ? 'WARNING' : (isGreen ? 'GREEN' : 'RED')}`;
    const alive = players.filter(p => p.alive).length;
    const finished = players.filter(p => p.finished).length;
    uiRound.textContent = `Players Alive: ${alive} | Finished: ${finished}`;
  }
  function updateUITimer() {
    const total = Math.ceil(timeRemainingMs / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (uiTimer) uiTimer.textContent = `Time: ${m}:${s.toString().padStart(2, '0')}`;
  }

  let lastTime = performance.now();

  function loop(now) {
    const dt = Math.min(0.033, (now - lastTime) / 1000);

    // Switch light if time
    if (now >= nextSwitchAt) toggleLight();
    // Enter warning window shortly before turning red
    if (!isWarning && isGreen && now >= warnAt) {
      isWarning = true;
    }

    // Update countdown and handle time-up mass elimination once
    timeRemainingMs = Math.max(0, GAME_DURATION_MS - (now - gameStartAt));
    if (timeRemainingMs === 0 && !timeUpTriggered) {
      for (const p of players) {
        if (p.alive && !p.finished) {
          markShot(p, { suppressPanic: true });
        }
      }
      timeUpTriggered = true;
    }

    // Update players
    for (const p of players) p.isMoving = false;

    // Human first, then AIs
    updateHuman(players[HUMAN_INDEX], dt);
    for (let i = 0; i < players.length; i++) {
      if (i === HUMAN_INDEX) continue;
      updateAI(players[i], dt, now);
    }

    postMoveCollisionAndRules(now);
    updateUILight();
    updateUITimer();
    draw();

    lastTime = now;
    requestAnimationFrame(loop);
  }

  // Init
  spawnPlayers();
  // Store initial prev positions for red-move detection
  for (const p of players) { p.px = p.x; p.py = p.y; }
  requestAnimationFrame(loop);
})();
