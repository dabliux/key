(() => {
  "use strict";

  // =========================
  // CONFIG
  // =========================
  const ASSET_BASE = "/caldero-caotico/assets/";

  const CONFIG = {
    gravityY: 1.05,
    timeStepMs: 1000 / 60,

    zoom: 1.0,
    camSmooth: 0.10,

    rotateSpeed: 0.055,
    extendSpeed: 6.0,
    minReach: 90,
    maxReach: 380,
    controlPull: 0.18,

    energyRegen: 0.14,
    energyMax: 100,

    burstCost: 18,
    dashCost: 26,
    hookCost: 10,
    slowCost: 22,

    burstCdMs: 900,
    dashCdMs: 2300,
    hookCdMs: 4500,
    slowCdMs: 9500,

    hookRange: 380,
    hookDurationMs: 2600,

    slowDurationMs: 2200,
    slowTimeScale: 0.35,

    fallYLimit: 1400,

    stageCount: 20,
    stageWidth: 520,
    stageStepUp: 120,
    stageBaseY: 820,
    stageBlockW: 460,
    stageBlockH: 90,

    plantEvery: 2,
    enemyEvery: 3,

    progressPadStart: 80,
    progressPadEnd: 280,

    assets: {
      background: ASSET_BASE + "bg.png?v=10",
      platformTile: ASSET_BASE + "grass.png?v=10",
      playerSprite: ASSET_BASE + "player.png?v=10",
      hammerSprite: ASSET_BASE + "hammer.png?v=10",
      plantSprite: ASSET_BASE + "plant.png?v=10",
      enemySprite: ASSET_BASE + "enemy.png?v=10",
      coinSprite: ASSET_BASE + "coin.png?v=10",
      checkpointSprite: ASSET_BASE + "check.png?v=10"
    },

    spriteSizes: {
      player: { w: 64, h: 64 },
      hammer: { w: 220, h: 40 },
      plant:  { w: 64, h: 64 },
      enemy:  { w: 72, h: 72 },
      coin:   { w: 28, h: 28 },
      check:  { w: 34, h: 34 }
    }
  };

  // =========================
  // DOM helpers
  // =========================
  const $ = (id) => document.getElementById(id);

  const canvas = $("game");
  const ctx = canvas.getContext("2d");

  const ui = {
    time: $("uiTime"),
    deaths: $("uiDeaths"),
    stage: $("uiStage"),
    coins: $("uiCoins"),
    height: $("uiHeight"),
    energyFill: $("uiEnergyFill"),
    energyVal: $("uiEnergyVal"),
    progressFill: $("progressFill"),
    progressText: $("progressText"),
    toast: $("toast"),
    modal: $("modal"),
    btnPlay: $("btnPlay"),
    btnResetData: $("btnResetData"),
    btnPause: $("btnPause"),
    btnRespawn: $("btnRespawn"),
    btnHelp: $("btnHelp"),
    cdBurst: $("cdBurst"),
    cdDash: $("cdDash"),
    cdHook: $("cdHook"),
    cdSlow: $("cdSlow")
  };

  function toast(msg, ms = 1800){
    if (!ui.toast) return;
    ui.toast.textContent = msg;
    ui.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => ui.toast.classList.remove("show"), ms);
  }

  function fmtTime(ms){
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${m}:${r.toFixed(1).padStart(4,"0")}`;
  }

  function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

  // =========================
  // Canvas resize
  // =========================
  function fit(){
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.floor(innerWidth * dpr);
    canvas.height = Math.floor(innerHeight * dpr);
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener("resize", fit);
  fit();

  // =========================
  // Assets (images)
  // =========================
  function loadImage(src, label){
    const im = new Image();
    im.decoding = "async";
    im._ok = false;
    im.onload = () => { im._ok = true; console.log("✅", label, src); };
    im.onerror = () => { im._ok = false; console.warn("❌", label, src); };
    im.src = src;
    return im;
  }

  const bgImg       = loadImage(CONFIG.assets.background, "bg");
  const platformImg = loadImage(CONFIG.assets.platformTile, "grass");
  const playerImg   = loadImage(CONFIG.assets.playerSprite, "player");
  const hammerImg   = loadImage(CONFIG.assets.hammerSprite, "hammer");
  const plantImg    = loadImage(CONFIG.assets.plantSprite, "plant");
  const enemyImg    = loadImage(CONFIG.assets.enemySprite, "enemy");
  const coinImg     = loadImage(CONFIG.assets.coinSprite, "coin");
  const checkImg    = loadImage(CONFIG.assets.checkpointSprite, "check");

  // =========================
  // Matter / World state
  // =========================
  let M = null;
  let engine = null, world = null;
  let started = false;
  let paused = false;

  // player bodies
  let pot = null, hammer = null, controlPoint = null;
  let jointPotHammer = null, jointTipControl = null;

  // hook ability
  let hookJoint = null;
  let hookUntil = 0;

  // arrays
  const platforms = [];
  const checkpoints = [];
  const coins = [];
  const plants = [];
  const enemies = [];

  // meta
  let deaths = 0;
  let coinCount = 0;
  let energy = CONFIG.energyMax;
  let startTs = 0;

  let checkpoint = { x:120, y:CONFIG.stageBaseY - 60, stage:1 };

  // hammer control
  let targetAngle = -0.15;
  let targetReach = 240;

  // slow-mo
  let slowUntil = 0;

  // camera
  const cam = { x:0, y:0 };

  // goal
  let goalX = 0;

  // cooldowns
  const cd = {
    burst: { last:-1e9, cool:CONFIG.burstCdMs },
    dash:  { last:-1e9, cool:CONFIG.dashCdMs },
    hook:  { last:-1e9, cool:CONFIG.hookCdMs },
    slow:  { last:-1e9, cool:CONFIG.slowCdMs }
  };

  function now(){ return performance.now(); }

  function canUse(key){ return (now() - cd[key].last) >= cd[key].cool; }
  function cdFrac(key){
    const dt = now() - cd[key].last;
    return clamp(dt / cd[key].cool, 0, 1);
  }
  function setCdUI(el, ready, frac){
    if (!el) return;
    el.classList.toggle("ready", ready);
    el.classList.toggle("cool", !ready);
    el.style.opacity = ready ? "1" : String(0.35 + 0.6*(1-frac));
  }

  function setEnergy(v){
    energy = clamp(v, 0, CONFIG.energyMax);
    if (ui.energyFill) ui.energyFill.style.width = `${(energy/CONFIG.energyMax)*100}%`;
    if (ui.energyVal) ui.energyVal.textContent = String(Math.round(energy));
  }

  function spend(cost){
    if (energy < cost) return false;
    setEnergy(energy - cost);
    return true;
  }

  // =========================
  // Drawing helpers
  // =========================
  function drawBackground(){
    if (bgImg && bgImg._ok) ctx.drawImage(bgImg, 0, 0, innerWidth, innerHeight);
    else {
      const grd = ctx.createLinearGradient(0,0,0,innerHeight);
      grd.addColorStop(0, "#274fa3");
      grd.addColorStop(1, "#050814");
      ctx.fillStyle = grd;
      ctx.fillRect(0,0,innerWidth,innerHeight);
    }
  }

  function splash(){
    ctx.clearRect(0,0,innerWidth,innerHeight);
    drawBackground();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0,0,innerWidth,innerHeight);
    ctx.fillStyle = "#fff";
    ctx.font = "900 22px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Listo. Presiona ▶ Jugar", innerWidth/2, innerHeight/2 - 10);
    ctx.font = "800 14px system-ui";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText("Si no ves nada, revisa F12 → Console", innerWidth/2, innerHeight/2 + 20);
    ctx.restore();
  }

  function worldToScreen(x,y){
    const w = innerWidth, h = innerHeight, z = CONFIG.zoom;
    return { x: (x - cam.x) * z + w/2, y: (y - cam.y) * z + h/2 };
  }

  function drawTiledRect(img, x,y,w,h){
    if (img && img._ok){
      const pat = ctx.createPattern(img, "repeat");
      ctx.fillStyle = pat;
      ctx.fillRect(x,y,w,h);
    } else {
      ctx.fillStyle = "#2aa84b";
      ctx.fillRect(x,y,w,h);
    }
  }

  function drawSprite(img, cx,cy, w,h, angle=0){
    if (img && img._ok){
      ctx.save();
      ctx.translate(cx,cy);
      ctx.rotate(angle);
      ctx.drawImage(img, -w/2, -h/2, w, h);
      ctx.restore();
      return true;
    }
    return false;
  }

  function render(){
    ctx.clearRect(0,0,innerWidth,innerHeight);
    drawBackground();

    if (!started || !pot || !hammer) return;

    // platforms
    for (const p of platforms){
      const pos = worldToScreen(p.position.x, p.position.y);
      const w = p._w * CONFIG.zoom, h = p._h * CONFIG.zoom;
      const x = pos.x - w/2, y = pos.y - h/2;

      drawTiledRect(platformImg, x, y, w, h);

      ctx.strokeStyle = "rgba(0,0,0,0.30)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.font = `900 ${Math.max(26, 46*CONFIG.zoom)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(p._stage), pos.x, pos.y);
      ctx.restore();
    }

    // decor / pickups
    for (const p of plants){
      const s = worldToScreen(p.position.x, p.position.y);
      const w = CONFIG.spriteSizes.plant.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.plant.h * CONFIG.zoom;
      drawSprite(plantImg, s.x, s.y - 18*CONFIG.zoom, w, h, 0);
    }

    for (const c of coins){
      const s = worldToScreen(c.position.x, c.position.y);
      const w = CONFIG.spriteSizes.coin.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.coin.h * CONFIG.zoom;
      drawSprite(coinImg, s.x, s.y, w, h, 0);
    }

    for (const c of checkpoints){
      const s = worldToScreen(c.position.x, c.position.y);
      const w = CONFIG.spriteSizes.check.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.check.h * CONFIG.zoom;
      drawSprite(checkImg, s.x, s.y, w, h, 0);
    }

    for (const e of enemies){
      const s = worldToScreen(e.position.x, e.position.y);
      const w = CONFIG.spriteSizes.enemy.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.enemy.h * CONFIG.zoom;
      drawSprite(enemyImg, s.x, s.y, w, h, 0);
    }

    // hook rope
    if (hookJoint){
      const tip = getHammerTip();
      const tipS = worldToScreen(tip.x, tip.y);
      const ax = hookJoint.bodyB.position.x + (hookJoint.pointB?.x || 0);
      const ay = hookJoint.bodyB.position.y + (hookJoint.pointB?.y || 0);
      const aS = worldToScreen(ax, ay);

      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tipS.x, tipS.y);
      ctx.lineTo(aS.x, aS.y);
      ctx.stroke();
      ctx.restore();
    }

    // player
    {
      const s = worldToScreen(pot.position.x, pot.position.y);
      const w = CONFIG.spriteSizes.player.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.player.h * CONFIG.zoom;
      drawSprite(playerImg, s.x, s.y, w, h, 0);
    }

    // hammer
    {
      const s = worldToScreen(hammer.position.x, hammer.position.y);
      const w = CONFIG.spriteSizes.hammer.w * CONFIG.zoom;
      const h = CONFIG.spriteSizes.hammer.h * CONFIG.zoom;
      drawSprite(hammerImg, s.x, s.y, w, h, hammer.angle);
    }
  }

  // =========================
  // World building
  // =========================
  function makePlatform(x,y,w,h, stageNum){
    const body = M.Bodies.rectangle(x,y,w,h,{
      isStatic:true, friction:0.9, restitution:0.0, label:"platform"
    });
    body._stage = stageNum; body._w = w; body._h = h;
    platforms.push(body);
    return body;
  }

  function makeCheckpoint(x,y,stageNum){
    const c = M.Bodies.circle(x,y,18,{ isStatic:true, isSensor:true, label:"checkpoint" });
    c._stage = stageNum;
    checkpoints.push(c);
    return c;
  }

  function makeCoin(x,y,stageNum){
    const c = M.Bodies.circle(x,y,12,{ isStatic:true, isSensor:true, label:"coin" });
    c._stage = stageNum;
    coins.push(c);
    return c;
  }

  function makePlant(x,y){
    const p = M.Bodies.circle(x,y,18,{ isStatic:true, isSensor:true, label:"plant" });
    plants.push(p);
    return p;
  }

  function makeEnemy(x,y,stageNum){
    const e = M.Bodies.rectangle(x,y,44,54,{
      friction:0.7, restitution:0.0, density:0.002, label:"enemy"
    });
    e._stage = stageNum;
    e._minX = x - 80;
    e._maxX = x + 80;
    e._dir = Math.random() < 0.5 ? -1 : 1;
    e._speed = 1.2 + Math.random()*0.6;
    enemies.push(e);
    return e;
  }

  function buildStages(){
    const leftWall  = M.Bodies.rectangle(-400, 0, 800, 8000, { isStatic:true, label:"wall" });
    const rightWall = M.Bodies.rectangle(CONFIG.stageCount*CONFIG.stageWidth + 900, 0, 800, 8000, { isStatic:true, label:"wall" });
    const floor = M.Bodies.rectangle(500, CONFIG.stageBaseY + 140, CONFIG.stageCount*CONFIG.stageWidth + 2000, 140, { isStatic:true, label:"floor" });
    M.Composite.add(world, [leftWall, rightWall, floor]);

    for (let i=1;i<=CONFIG.stageCount;i++){
      const x = (i-1)*CONFIG.stageWidth + 260;
      const y = CONFIG.stageBaseY - (i-1)*CONFIG.stageStepUp;

      makePlatform(x, y, CONFIG.stageBlockW, CONFIG.stageBlockH, i);

      if (i % 2 === 0) makePlatform(x + 220, y - 70, 260, 40, i);
      else makePlatform(x - 220, y - 60, 240, 36, i);

      if (i === 1 || i % 3 === 0) makeCheckpoint(x + 120, y - 70, i);

      if (i % 2 === 1) makeCoin(x - 60, y - 95, i);
      if (i % 4 === 0) makeCoin(x + 80, y - 120, i);

      if (i % CONFIG.plantEvery === 0) makePlant(x + (Math.random()*160 - 80), y - 40);

      if (i % CONFIG.enemyEvery === 0 && i < CONFIG.stageCount) makeEnemy(x + 100, y - 70, i);

      if (i % 5 === 0) makePlatform(x + 260, y - 120, 50, 240, i);
    }

    // goal X for progress calc
    goalX = (CONFIG.stageCount-1)*CONFIG.stageWidth + 520;
  }

  function buildPlayer(){
    const group = -1;

    pot = M.Bodies.circle(120, CONFIG.stageBaseY - 60, 26, {
      label:"player",
      friction:0.9,
      frictionAir:0.02,
      restitution:0.0,
      density:0.006,
      collisionFilter:{ group }
    });

    hammer = M.Bodies.rectangle(260, CONFIG.stageBaseY - 120, 180, 18, {
      label:"hammer",
      friction:0.9,
      frictionAir:0.01,
      restitution:0.03,
      density:0.0035,
      collisionFilter:{ group }
    });

    controlPoint = M.Bodies.circle(340, CONFIG.stageBaseY - 180, 6, {
      isStatic:true,
      collisionFilter:{ mask:0 },
      label:"controlPoint"
    });

    jointPotHammer = M.Constraint.create({
      bodyA: pot, pointA: { x:0, y:0 },
      bodyB: hammer, pointB: { x:-70, y:0 },
      stiffness: 0.98, damping: 0.06, length: 18
    });

    jointTipControl = M.Constraint.create({
      bodyA: hammer, pointA: { x:80, y:0 },
      bodyB: controlPoint,
      stiffness: CONFIG.controlPull,
      damping: 0.18,
      length: 0
    });

    M.Composite.add(world, [pot, hammer, controlPoint, jointPotHammer, jointTipControl]);

    checkpoint = { x: pot.position.x, y: pot.position.y, stage: 1 };
    cam.x = pot.position.x; cam.y = pot.position.y;

    targetAngle = -0.15;
    targetReach = 240;
  }

  // =========================
  // Input (keyboard only)
  // =========================
  const keys = Object.create(null);

  window.addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (e.repeat) return;

    // abilities
    if (e.code === "Space"){ e.preventDefault(); doBurst(); }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight"){ doDash(); }
    if (e.code === "KeyF"){ doHook(); }
    if (e.code === "KeyQ"){ doSlow(); }
    if (e.code === "KeyR"){ if (started) respawn(); }
  });

  window.addEventListener("keyup", (e) => { keys[e.code] = false; });

  function leftHeld(){ return keys["KeyA"] || keys["ArrowLeft"]; }
  function rightHeld(){ return keys["KeyD"] || keys["ArrowRight"]; }
  function upHeld(){ return keys["KeyW"] || keys["ArrowUp"]; }
  function downHeld(){ return keys["KeyS"] || keys["ArrowDown"]; }

  // ✅ NO CRASHEA: solo corre si pot/controlPoint existen
  function updateHammerTarget(){
    if (!M || !pot || !controlPoint) return;

    if (leftHeld())  targetAngle -= CONFIG.rotateSpeed;
    if (rightHeld()) targetAngle += CONFIG.rotateSpeed;

    if (upHeld())   targetReach += CONFIG.extendSpeed;
    if (downHeld()) targetReach -= CONFIG.extendSpeed;

    targetReach = clamp(targetReach, CONFIG.minReach, CONFIG.maxReach);

    const px = pot.position.x;
    const py = pot.position.y;
    const tx = px + Math.cos(targetAngle) * targetReach;
    const ty = py + Math.sin(targetAngle) * targetReach;

    M.Body.setPosition(controlPoint, { x: tx, y: ty });
  }

  function updateCamera(){
    if (!pot) return;
    const tx = pot.position.x;
    const ty = pot.position.y - 80;
    cam.x += (tx - cam.x) * CONFIG.camSmooth;
    cam.y += (ty - cam.y) * CONFIG.camSmooth;
  }

  function respawn(){
    if (!M || !pot || !hammer) return;

    deaths++;
    if (ui.deaths) ui.deaths.textContent = String(deaths);
    toast(`💀 Respawn (Etapa ${checkpoint.stage})`);

    M.Body.setPosition(pot, { x: checkpoint.x, y: checkpoint.y });
    M.Body.setVelocity(pot, { x: 0, y: 0 });
    M.Body.setAngularVelocity(pot, 0);

    M.Body.setPosition(hammer, { x: checkpoint.x + 160, y: checkpoint.y - 80 });
    M.Body.setVelocity(hammer, { x: 0, y: 0 });
    M.Body.setAngularVelocity(hammer, 0);

    releaseHook();
    setEnergy(Math.max(40, energy));
  }

  function updateEnemies(){
    if (!M) return;
    for (const e of enemies){
      M.Body.setAngularVelocity(e, 0);
      e.angle = 0;
      const vx = e._dir * e._speed;
      M.Body.setVelocity(e, { x: vx, y: e.velocity.y });
      if (e.position.x < e._minX) e._dir = 1;
      if (e.position.x > e._maxX) e._dir = -1;
    }
  }

  // =========================
  // Abilities
  // =========================
  function getHammerTip(){
    if (!M || !hammer) return { x:0, y:0 };
    const local = { x:80, y:0 };
    const rot = M.Vector.rotate(local, hammer.angle);
    return M.Vector.add(hammer.position, rot);
  }

  function doBurst(){
    if (!started || !M || !pot || !hammer) return;
    if (!canUse("burst")) return;
    if (!spend(CONFIG.burstCost)){ toast("⚡ Sin energía para Burst"); return; }
    cd.burst.last = now();

    const tip = getHammerTip();
    const dir = M.Vector.normalise(M.Vector.sub(pot.position, tip));
    const force = M.Vector.mult(dir, 0.030);
    M.Body.applyForce(pot, pot.position, { x: force.x, y: force.y - 0.010 });

    toast("⤴ Burst!");
  }

  function doDash(){
    if (!started || !M || !pot) return;
    if (!canUse("dash")) return;
    if (!spend(CONFIG.dashCost)){ toast("⚡ Sin energía para Dash"); return; }
    cd.dash.last = now();

    const dx = Math.cos(targetAngle);
    M.Body.applyForce(pot, pot.position, { x: dx * 0.040, y: -0.010 });
    toast("⇢ Dash!");
  }

  function releaseHook(){
    if (!hookJoint || !M) return;
    M.Composite.remove(world, hookJoint);
    hookJoint = null;
    hookUntil = 0;
  }

  function doHook(){
    if (!started || !M || !pot || !hammer || !world) return;
    if (!canUse("hook")) return;
    // toggle off
    if (hookJoint){
      releaseHook();
      toast("🪝 Gancho: soltado");
      return;
    }

    if (!spend(CONFIG.hookCost)){ toast("⚡ Sin energía para Gancho"); return; }
    cd.hook.last = now();

    const tip = getHammerTip();
    const end = {
      x: tip.x + Math.cos(targetAngle) * CONFIG.hookRange,
      y: tip.y + Math.sin(targetAngle) * CONFIG.hookRange
    };

    // Only static bodies for hooking
    const statics = M.Composite.allBodies(world).filter(b => b.isStatic && (
      b.label === "platform" || b.label === "wall" || b.label === "floor"
    ));
    const hits = M.Query.ray(statics, tip, end, 10);

    if (!hits.length){
      toast("❌ No hay dónde enganchar.");
      return;
    }

    const hit = hits[0];
    hookJoint = M.Constraint.create({
      bodyA: hammer,
      pointA: { x:80, y:0 },
      bodyB: hit.body,
      pointB: { x: hit.point.x - hit.body.position.x, y: hit.point.y - hit.body.position.y },
      stiffness: 0.98,
      damping: 0.04,
      length: 0
    });

    M.Composite.add(world, hookJoint);
    hookUntil = now() + CONFIG.hookDurationMs;
    toast("🪝 Gancho activado!");
  }

  function doSlow(){
    if (!started) return;
    if (!canUse("slow")) return;
    if (!spend(CONFIG.slowCost)){ toast("⚡ Sin energía para Slow"); return; }
    cd.slow.last = now();
    slowUntil = now() + CONFIG.slowDurationMs;
    toast("🐢 Slow-Mo!");
  }

  // =========================
  // Collisions (coins/checkpoint/enemy)
  // =========================
  function initCollisions(){
    if (!M || !engine) return;

    M.Events.on(engine, "collisionStart", (ev) => {
      for (const pair of ev.pairs){
        const a = pair.bodyA, b = pair.bodyB;

        // coin
        if ((a.label==="player" && b.label==="coin") || (b.label==="player" && a.label==="coin")){
          const coinBody = (a.label==="coin") ? a : b;
          M.Composite.remove(world, coinBody);
          const idx = coins.indexOf(coinBody);
          if (idx >= 0) coins.splice(idx, 1);
          coinCount++;
          if (ui.coins) ui.coins.textContent = String(coinCount);
          continue;
        }

        // checkpoint
        if ((a.label==="player" && b.label==="checkpoint") || (b.label==="player" && a.label==="checkpoint")){
          const cp = (a.label==="checkpoint") ? a : b;
          checkpoint = { x: cp.position.x, y: cp.position.y - 40, stage: cp._stage || 1 };
          toast(`✅ Checkpoint: Etapa ${checkpoint.stage}`);
          continue;
        }

        // enemy
        if ((a.label==="player" && b.label==="enemy") || (b.label==="player" && a.label==="enemy")){
          respawn();
          continue;
        }
      }
    });
  }

  // =========================
  // UI updates
  // =========================
  function updateUI(){
    if (!pot) return;

    const t = now() - startTs;
    if (ui.time) ui.time.textContent = fmtTime(t);

    const stageNow = clamp(1 + Math.floor(pot.position.x / CONFIG.stageWidth), 1, CONFIG.stageCount);
    if (ui.stage) ui.stage.textContent = String(stageNow);

    const h = Math.max(0, Math.round((-pot.position.y) / 10));
    if (ui.height) ui.height.textContent = String(h);

    setEnergy(energy + CONFIG.energyRegen);

    setCdUI(ui.cdBurst, canUse("burst"), cdFrac("burst"));
    setCdUI(ui.cdDash,  canUse("dash"),  cdFrac("dash"));
    setCdUI(ui.cdHook,  canUse("hook"),  cdFrac("hook"));
    setCdUI(ui.cdSlow,  canUse("slow"),  cdFrac("slow"));

    // progress bar based on X
    const startX = CONFIG.progressPadStart;
    const endX = goalX - CONFIG.progressPadEnd;
    const pct = clamp((pot.position.x - startX) / (endX - startX), 0, 1);
    if (ui.progressFill) ui.progressFill.style.width = `${Math.round(pct*100)}%`;
    if (ui.progressText) ui.progressText.textContent = `${Math.round(pct*100)}%`;
  }

  // =========================
  // Start game
  // =========================
  function startGame(){
    if (!window.Matter){
      toast("❌ Matter.js no cargó. Ctrl+F5", 4000);
      return;
    }

    M = window.Matter;
    engine = M.Engine.create();
    world = engine.world;
    world.gravity.y = CONFIG.gravityY;

    // reset arrays
    platforms.length = 0;
    checkpoints.length = 0;
    coins.length = 0;
    plants.length = 0;
    enemies.length = 0;

    deaths = 0;
    coinCount = 0;
    setEnergy(CONFIG.energyMax);
    if (ui.deaths) ui.deaths.textContent = "0";
    if (ui.coins) ui.coins.textContent = "0";

    // build
    buildStages();
    buildPlayer();

    M.Composite.add(world, [...platforms, ...checkpoints, ...coins, ...plants, ...enemies]);

    // collisions
    initCollisions();

    started = true;
    paused = false;
    startTs = now();

    toast("✅ Juego iniciado. (WASD / Flechas)", 2000);
  }

  // =========================
  // Buttons
  // =========================
  if (ui.btnPlay) ui.btnPlay.addEventListener("click", () => {
    if (ui.modal) ui.modal.classList.add("hidden");
    startGame();
  });

  if (ui.btnPause) ui.btnPause.addEventListener("click", () => {
    paused = !paused;
    toast(paused ? "⏸️ Pausado" : "▶️ Continuar");
  });

  if (ui.btnRespawn) ui.btnRespawn.addEventListener("click", () => {
    if (started) respawn();
  });

  if (ui.btnHelp) ui.btnHelp.addEventListener("click", () => {
    toast("W/↑ extiende, S/↓ encoge, A/← rota izq, D/→ rota der. SPACE Burst, SHIFT Dash, F Gancho, Q Slow, R Checkpoint", 3600);
  });

  if (ui.btnResetData) ui.btnResetData.addEventListener("click", () => {
    location.reload();
  });

  // =========================
  // Main loop (NO CRASHEA)
  // =========================
  function tick(){
    if (!started) splash();
    else render();

    if (started && !paused && engine && M && pot && hammer && controlPoint){
      updateHammerTarget();
      updateEnemies();

      // slow-mo
      const ts = (slowUntil && now() < slowUntil) ? CONFIG.slowTimeScale : 1.0;

      // hook timeout
      if (hookJoint && now() > hookUntil) releaseHook();

      M.Engine.update(engine, CONFIG.timeStepMs * ts);

      updateCamera();

      if (pot.position.y > CONFIG.fallYLimit) respawn();

      updateUI();
    }

    window.requestAnimationFrame(tick);
  }

  window.requestAnimationFrame(tick);

})();
