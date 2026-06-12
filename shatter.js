/* ============================================================
   Realistic glass-shatter animation
   ------------------------------------------------------------
   Phases:
     1. tremble        — the pane vibrates under stress
     2. first impact   — inner radial cracks snap in + flash
     3. second impact  — the full crack web forms, the pane is
                         swapped for ~45 individually clipped
                         shards holding together with micro-gaps
     4. shatter        — shards fly out from the impact point,
                         tumble in 3D, fall under gravity,
                         bounce on the floor and fade out;
                         glass dust sparks on every impact
     5. solution       — the new pane snaps into focus, sharp,
                         with a glow pulse and a mirror shine
   Everything is vector/DOM based, so it is crisp on any screen.
   ============================================================ */
(() => {
  "use strict";

  const stage      = document.getElementById("heroStage");
  const shakeWrap  = document.getElementById("shakeWrap");
  const swapArea   = document.getElementById("swapArea");
  const box        = document.getElementById("problemBox");
  const solution   = document.getElementById("solutionBox");
  const shardLayer = document.getElementById("shardLayer");
  const canvas     = document.getElementById("fxCanvas");
  const flashEl    = document.getElementById("impactFlash");
  const floorGlow  = document.getElementById("floorGlow");
  const replayBtn  = document.getElementById("replayBtn");
  const ctx        = canvas.getContext("2d");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const GRAVITY      = 2700;   // px / s²
  const RESTITUTION  = 0.30;   // floor bounce energy kept
  const SHARD_LIFE   = 3000;   // ms before remaining shards are force-faded
  const TAU          = Math.PI * 2;

  const rand = (a, b) => a + Math.random() * (b - a);

  let dpr = 1;
  let shards = [];
  let particles = [];
  let crackSvg = null;
  let rafId = null;
  let lastT = 0;
  let shatterAt = 0;
  let physicsOn = false;
  let running = false;

  /* ---------------- canvas ---------------- */

  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(stage.clientWidth * dpr);
    canvas.height = Math.round(stage.clientHeight * dpr);
    canvas.style.width = stage.clientWidth + "px";
    canvas.style.height = stage.clientHeight + "px";
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  /* ---------------- geometry helpers ---------------- */

  function polygonArea(p) {
    let s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      s += a.x * b.y - b.x * a.y;
    }
    return Math.abs(s) / 2;
  }

  function polygonCentroid(p) {
    let cx = 0, cy = 0, s = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const cross = a.x * b.y - b.x * a.y;
      s += cross;
      cx += (a.x + b.x) * cross;
      cy += (a.y + b.y) * cross;
    }
    if (Math.abs(s) < 1e-6) return p[0];
    s *= 3;
    return { x: cx / s, y: cy / s };
  }

  /* Sutherland–Hodgman clip of a polygon against rect (0,0,w,h) */
  function clipToRect(poly, w, h) {
    const planes = [
      (p) => p.x >= 0, (p) => p.x <= w,
      (p) => p.y >= 0, (p) => p.y <= h,
    ];
    const lerps = [
      (a, b) => { const t = (0 - a.x) / (b.x - a.x); return { x: 0, y: a.y + (b.y - a.y) * t }; },
      (a, b) => { const t = (w - a.x) / (b.x - a.x); return { x: w, y: a.y + (b.y - a.y) * t }; },
      (a, b) => { const t = (0 - a.y) / (b.y - a.y); return { x: a.x + (b.x - a.x) * t, y: 0 }; },
      (a, b) => { const t = (h - a.y) / (b.y - a.y); return { x: a.x + (b.x - a.x) * t, y: h }; },
    ];
    let out = poly;
    for (let k = 0; k < 4 && out.length; k++) {
      const inp = out;
      out = [];
      for (let i = 0; i < inp.length; i++) {
        const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
        const curIn = planes[k](cur), prevIn = planes[k](prev);
        if (curIn) {
          if (!prevIn) out.push(lerps[k](prev, cur));
          out.push(cur);
        } else if (prevIn) {
          out.push(lerps[k](prev, cur));
        }
      }
    }
    return out;
  }

  /* Radial + concentric crack web — how real tempered glass fails */
  function buildPattern(w, h, impact) {
    const { x: cx, y: cy } = impact;
    const maxR = Math.max(
      Math.hypot(cx, cy), Math.hypot(w - cx, cy),
      Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)
    );
    const SPOKES = 13;
    const RINGS = [0.14, 0.30, 0.52, 0.80, 1.22]; // fractions of maxR; last extends past the edges

    const angles = [];
    for (let i = 0; i < SPOKES; i++) angles.push((i / SPOKES) * TAU + rand(-0.13, 0.13));
    angles.sort((a, b) => a - b);

    // shared jittered vertex grid: verts[ring][spoke]
    const verts = RINGS.map((fr) =>
      angles.map((a) => {
        const r = fr * maxR * rand(0.90, 1.10);
        const aj = a + rand(-0.045, 0.045);
        return { x: cx + Math.cos(aj) * r, y: cy + Math.sin(aj) * r };
      })
    );

    const cells = [];
    for (let i = 0; i < SPOKES; i++) {
      const j = (i + 1) % SPOKES;
      cells.push([{ x: cx, y: cy }, verts[0][i], verts[0][j]]);
    }
    for (let r = 0; r < RINGS.length - 1; r++) {
      for (let i = 0; i < SPOKES; i++) {
        const j = (i + 1) % SPOKES;
        cells.push([verts[r][i], verts[r + 1][i], verts[r + 1][j], verts[r][j]]);
      }
    }
    return { cells, verts, impact, maxR, spokes: SPOKES };
  }

  /* ---------------- crack overlay ---------------- */

  function pathD(points) {
    return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  }

  /* subdivide segments with perpendicular jitter — hairline jaggedness
     that straight SVG lines lack */
  function jag(points, amp) {
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const n = len > 90 ? 3 : len > 40 ? 2 : 1;
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const j = amp * len * rand(-1, 1);
        out.push({ x: a.x + dx * t - (dy / len) * j, y: a.y + dy * t + (dx / len) * j });
      }
      out.push(b);
    }
    return out;
  }

  function buildCrackSvg(pattern, w, h, offX, offY) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "crack-svg");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.style.left = offX + "px";
    svg.style.top = offY + "px";
    svg.style.width = w + "px";
    svg.style.height = h + "px";

    const NS = "http://www.w3.org/2000/svg";
    const add = (d, stage, glow, wMin, wMax) => {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      p.setAttribute("pathLength", "1");
      p.setAttribute("class", stage + (glow ? " glow" : ""));
      p.style.transitionDelay = rand(0, 0.06).toFixed(3) + "s";
      if (!glow) {
        p.style.strokeWidth = rand(wMin || 0.5, wMax || 1.2).toFixed(2);
        p.style.strokeOpacity = rand(0.55, 1).toFixed(2);
      }
      svg.appendChild(p);
    };

    const { verts, impact, spokes } = pattern;

    // frosted crush zone right at the impact point
    svg.innerHTML =
      `<defs><radialGradient id="frostG"><stop offset="0%" stop-color="rgba(240,252,255,.55)"/>` +
      `<stop offset="45%" stop-color="rgba(200,240,255,.18)"/>` +
      `<stop offset="100%" stop-color="rgba(200,240,255,0)"/></radialGradient></defs>` +
      `<circle class="frost" cx="${impact.x.toFixed(1)}" cy="${impact.y.toFixed(1)}" r="30" fill="url(#frostG)"/>`;
    // dense micro-fractures around the crush zone
    for (let i = 0; i < 22; i++) {
      const a = rand(0, TAU), r0 = rand(2, 9), r1 = r0 + rand(5, 22);
      const d = pathD(jag([
        { x: impact.x + Math.cos(a) * r0, y: impact.y + Math.sin(a) * r0 },
        { x: impact.x + Math.cos(a) * r1, y: impact.y + Math.sin(a) * r1 },
      ], 0.12));
      add(d, "st1", false, 0.4, 0.8);
    }

    // radial cracks dominate: every spoke runs from the impact to the edge
    for (let i = 0; i < spokes; i++) {
      const d1 = pathD(jag([impact, verts[0][i], verts[1][i]], 0.045));
      add(d1, "st1", true); add(d1, "st1", false);
      const d2 = pathD(jag([verts[1][i], verts[2][i], verts[3][i], verts[4][i]], 0.04));
      add(d2, "st2", true); add(d2, "st2", false);
      // short secondary forks branching off the spoke
      if (Math.random() < 0.75) {
        const v = verts[1 + Math.floor(rand(0, 2))][i];
        const a0 = Math.atan2(v.y - impact.y, v.x - impact.x) + rand(0.45, 0.95) * (Math.random() < 0.5 ? -1 : 1);
        const len = rand(22, 60);
        const d = pathD(jag([v, { x: v.x + Math.cos(a0) * len, y: v.y + Math.sin(a0) * len }], 0.1));
        add(d, "st2", false, 0.4, 0.8);
      }
    }
    // concentric cracks are partial arcs — real glass never forms full rings
    const ringDefs = [
      { r: 0, stage: "st1", p: 0.85 },
      { r: 1, stage: "st2", p: 0.70 },
      { r: 2, stage: "st2", p: 0.62 },
      { r: 3, stage: "st2", p: 0.50 },
    ];
    for (const { r, stage: st, p } of ringDefs) {
      for (let i = 0; i < spokes; i++) {
        if (Math.random() > p) continue;
        const d = pathD(jag([verts[r][i], verts[r][(i + 1) % spokes]], 0.06));
        add(d, st, true); add(d, st, false);
      }
    }
    // sparkle glints where cracks intersect
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < spokes; i++) {
        if (Math.random() > 0.3) continue;
        const v = verts[r][i];
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("class", "glint");
        c.setAttribute("cx", v.x.toFixed(1));
        c.setAttribute("cy", v.y.toFixed(1));
        c.setAttribute("r", rand(0.8, 1.6).toFixed(1));
        c.style.transitionDelay = rand(0, 0.15).toFixed(2) + "s";
        svg.appendChild(c);
      }
    }
    return svg;
  }

  /* ---------------- shards ---------------- */

  function makeShards(pattern, boxRect, stageRect) {
    const w = boxRect.width, h = boxRect.height;
    const offX = boxRect.left - stageRect.left;
    const offY = boxRect.top - stageRect.top;
    const floorY = stage.clientHeight - 64;
    const { x: ix, y: iy } = pattern.impact;

    pattern.cells.forEach((cell) => {
      const poly = clipToRect(cell, w, h);
      if (poly.length < 3 || polygonArea(poly) < 70) return;

      const c = polygonCentroid(poly);
      // shard element is only as large as the fragment itself — keeping
      // ~50 composited layers tiny instead of card-sized (critical for
      // mobile GPUs and to avoid the compositor dropping layers)
      const bx = Math.floor(Math.min(...poly.map((p) => p.x)));
      const by = Math.floor(Math.min(...poly.map((p) => p.y)));
      const bw = Math.ceil(Math.max(...poly.map((p) => p.x))) - bx;
      const bh = Math.ceil(Math.max(...poly.map((p) => p.y))) - by;

      const el = document.createElement("div");
      el.className = "shard";
      el.setAttribute("aria-hidden", "true");
      el.style.left = (offX + bx) + "px";
      el.style.top = (offY + by) + "px";
      el.style.width = bw + "px";
      el.style.height = bh + "px";
      el.style.clipPath = "polygon(" +
        poly.map((p) => `${(p.x - bx).toFixed(1)}px ${(p.y - by).toFixed(1)}px`).join(",") + ")";
      el.style.transformOrigin = `${(c.x - bx).toFixed(1)}px ${(c.y - by).toFixed(1)}px`;

      // full card clone shifted so the right slice shows through the window
      const content = box.cloneNode(true);
      content.removeAttribute("id");
      content.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      content.classList.remove("tremble");
      content.style.position = "absolute";
      content.style.left = -bx + "px";
      content.style.top = -by + "px";
      content.style.width = w + "px";
      content.style.height = h + "px";
      content.style.margin = "0";
      content.style.visibility = "visible";
      content.style.opacity = "0.92"; // glass is never fully opaque
      el.appendChild(content);

      // cool translucent body tint so the fragment reads as crystal
      const tint = document.createElement("div");
      tint.className = "shard-tint";
      el.appendChild(tint);

      const glare = document.createElement("div");
      glare.className = "shard-glare";
      glare.style.setProperty("--ga", Math.round(rand(80, 160)) + "deg");
      el.appendChild(glare);

      // bright specular line along the actual fracture edges —
      // the single strongest cue that a fragment is glass
      const edge = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      edge.setAttribute("class", "shard-edge");
      edge.setAttribute("viewBox", `0 0 ${bw} ${bh}`);
      const pts = poly.map((p) => `${(p.x - bx).toFixed(1)},${(p.y - by).toFixed(1)}`).join(" ");
      edge.innerHTML =
        `<polygon points="${pts}" class="eg"/>` +
        `<polygon points="${pts}" class="ec"/>`;
      el.appendChild(edge);
      shardLayer.appendChild(el);

      // outward velocity from the impact point; closer shards get more energy
      const dx = c.x - ix, dy = c.y - iy;
      const dist = Math.hypot(dx, dy) || 1;
      const ang = Math.atan2(dy, dx);
      const energy = Math.max(0, 1 - dist / pattern.maxR);
      const speed = rand(50, 130) + 330 * energy * rand(0.7, 1.15);

      const s = {
        el, glare, c,
        // start from the micro-offsets of the "cracked but holding" phase
        tx: rand(-1.6, 1.6), ty: rand(-1, 2), tz: 0,
        rx: 0, ry: 0, rz: rand(-0.012, 0.012),
        vx: Math.cos(ang) * speed * rand(0.75, 1.2),
        vy: Math.sin(ang) * speed * rand(0.75, 1.2) - rand(0, 140) * energy,
        vz: rand(-140, 260) * (0.3 + energy),
        wrx: rand(-3.4, 3.4) * (0.4 + energy),
        wry: rand(-3.4, 3.4) * (0.4 + energy),
        wrz: rand(-1.8, 1.8),
        delay: (dist / pattern.maxR) * 200 * rand(0.7, 1.3),
        born: false,
        bounces: 0,
        settledAt: 0,
        opacity: 1,
        floorTy: Math.max(60, floorY - (offY + c.y) - rand(0, 26)),
        glintAng: rand(0, TAU),
        pageX: offX + c.x,
        pageY: offY + c.y,
      };
      applyShardTransform(s);
      shards.push(s);
    });
  }

  function applyShardTransform(s) {
    s.el.style.transform =
      `translate3d(${s.tx.toFixed(2)}px, ${s.ty.toFixed(2)}px, ${s.tz.toFixed(2)}px) ` +
      `rotateX(${(s.rx * 57.2958).toFixed(2)}deg) ` +
      `rotateY(${(s.ry * 57.2958).toFixed(2)}deg) ` +
      `rotateZ(${(s.rz * 57.2958).toFixed(2)}deg)`;
  }

  /* ---------------- particles (glass dust / glints) ---------------- */

  function spawnBurst(x, y, n, speed, up) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const v = rand(0.15, 1) * speed;
      particles.push({
        x, y,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (up || 0) * rand(0.3, 1),
        life: rand(0.35, 0.95),
        age: 0,
        size: rand(0.7, 2.4),
        hue: Math.random() < 0.7 ? 195 : 0, // mostly cyan-white, some pure white
      });
    }
  }

  function drawParticles(dt) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!particles.length) return;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.globalCompositeOperation = "lighter";
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) { particles.splice(i, 1); continue; }
      p.vy += GRAVITY * 0.55 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = 1 - p.age / p.life;
      const sat = p.hue ? "85%" : "0%";
      ctx.strokeStyle = `hsla(${p.hue}, ${sat}, ${p.hue ? 82 : 100}%, ${(0.85 * k).toFixed(3)})`;
      ctx.lineWidth = p.size * k;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02); // tiny streak along velocity
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- impact flash + camera shake ---------------- */

  function flash(x, y, scale, dur) {
    flashEl.style.left = x + "px";
    flashEl.style.top = y + "px";
    flashEl.animate(
      [
        { opacity: 0.95, transform: `translate(-50%,-50%) scale(${scale * 0.45})` },
        { opacity: 0, transform: `translate(-50%,-50%) scale(${scale})` },
      ],
      { duration: dur, easing: "cubic-bezier(.1,.6,.3,1)" }
    );
  }

  function shake(amp, dur) {
    const frames = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const k = 1 - i / n;
      frames.push({
        transform: i === n ? "translate(0,0)" :
          `translate(${rand(-amp, amp) * k}px, ${rand(-amp, amp) * k}px)`,
      });
    }
    shakeWrap.animate(frames, { duration: dur, easing: "linear" });
  }

  /* ---------------- main physics loop ---------------- */

  function tick(t) {
    const dt = Math.min((t - lastT) / 1000, 0.032);
    lastT = t;

    if (physicsOn) {
      const now = performance.now();
      const elapsed = now - shatterAt;
      let alive = 0;

      for (let i = shards.length - 1; i >= 0; i--) {
        const s = shards[i];
        if (!s.born) {
          if (elapsed >= s.delay) s.born = true;
          else { alive++; continue; }
        }

        if (!s.settledAt) {
          s.vy += GRAVITY * dt;
          s.tx += s.vx * dt;
          s.ty += s.vy * dt;
          s.tz += s.vz * dt;
          s.vz *= 1 - 1.6 * dt;
          s.rx += s.wrx * dt;
          s.ry += s.wry * dt;
          s.rz += s.wrz * dt;

          if (s.ty >= s.floorTy && s.vy > 0) {
            s.ty = s.floorTy;
            if (s.vy > 90 && s.bounces < 3) {
              s.vy = -s.vy * RESTITUTION * rand(0.8, 1.1);
              s.vx *= 0.55;
              s.wrx *= 0.45; s.wry *= 0.45; s.wrz *= 0.6;
              s.bounces++;
              spawnBurst(s.pageX + s.tx, s.pageY + s.ty, 6, 180, 120);
              floorGlow.classList.add("lit");
            } else {
              s.vy = 0; s.vx *= 0.2;
              s.wrx = s.wry = s.wrz = 0;
              // lie flat-ish on the floor
              s.rx = s.rx % TAU;
              s.settledAt = now;
            }
          }
        }

        // peaky specular: mostly dim with sudden bright prismatic flashes,
        // the way real glass catches light while tumbling
        const raw = Math.abs(Math.sin(s.rx + s.glintAng) * Math.cos(s.ry));
        const g = Math.pow(raw, 2.6);
        s.glare.style.opacity = Math.min(1, 0.1 + 1.05 * g).toFixed(3);

        // fade after settling, or force-fade at end of life
        const fadeStart = s.settledAt ? s.settledAt + 650 : shatterAt + SHARD_LIFE;
        if (now > fadeStart) {
          s.opacity -= dt / 0.55;
          if (s.opacity <= 0) {
            s.el.remove();
            shards.splice(i, 1);
            continue;
          }
          s.el.style.opacity = s.opacity.toFixed(3);
        }
        applyShardTransform(s);
        alive++;
      }
      if (!alive) physicsOn = false;
    }

    drawParticles(dt);

    if (physicsOn || particles.length) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function ensureLoop() {
    if (rafId == null) {
      lastT = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  /* ---------------- sequence ---------------- */

  function play() {
    if (running) return;
    running = true;
    replayBtn.hidden = true;

    if (reducedMotion) {
      box.style.visibility = "hidden";
      solution.classList.add("enter");
      running = false;
      replayBtn.hidden = false;
      return;
    }

    sizeCanvas();
    const stageRect = stage.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const w = boxRect.width, h = boxRect.height;
    const offX = boxRect.left - stageRect.left;
    const offY = boxRect.top - stageRect.top;

    const impact = { x: w * rand(0.4, 0.52), y: h * rand(0.34, 0.46) };
    const pattern = buildPattern(w, h, impact);
    const fx = offX + impact.x, fy = offY + impact.y;

    crackSvg = buildCrackSvg(pattern, w, h, offX, offY);
    stage.appendChild(crackSvg);

    // 1 — the pane trembles under stress
    box.classList.add("tremble");

    // 2 — first impact: inner cracks snap in
    setTimeout(() => {
      crackSvg.classList.add("s1");
      flash(fx, fy, 0.8, 260);
      shake(3, 220);
      spawnBurst(fx, fy, 18, 260, 60);
      ensureLoop();
    }, 420);

    // 3 — second impact: full web; swap pane for shards holding together
    setTimeout(() => {
      crackSvg.classList.add("s2", "bright");
      flash(fx, fy, 1.15, 300);
      shake(5, 280);
      spawnBurst(fx, fy, 28, 340, 90);
      ensureLoop();

      makeShards(pattern, boxRect, stageRect);
      box.classList.remove("tremble");
      box.style.visibility = "hidden";
    }, 880);

    // 4 — shatter: physics on
    setTimeout(() => {
      crackSvg.classList.add("gone");
      flash(fx, fy, 1.7, 420);
      shake(9, 420);
      spawnBurst(fx, fy, 90, 620, 160);
      shatterAt = performance.now();
      physicsOn = true;
      ensureLoop();
      setTimeout(() => crackSvg && crackSvg.remove(), 250);
    }, 1480);

    // 5 — once the glass has hit the floor, the solution pane snaps into focus
    setTimeout(() => {
      solution.classList.add("enter");
      setTimeout(() => solution.classList.add("shine"), 430);
    }, 2680);

    // wrap-up
    setTimeout(() => {
      floorGlow.classList.remove("lit");
      running = false;
      replayBtn.hidden = false;
    }, 5000);
  }

  function reset() {
    if (running) return;
    shards.forEach((s) => s.el.remove());
    shards = [];
    particles = [];
    physicsOn = false;
    if (crackSvg) { crackSvg.remove(); crackSvg = null; }
    solution.classList.remove("enter", "shine");
    floorGlow.classList.remove("lit");
    box.style.visibility = "visible";
    // force style flush so the solution card re-hides before replaying
    void solution.offsetWidth;
  }

  replayBtn.addEventListener("click", () => {
    reset();
    setTimeout(play, 350);
  });

  // play once when the hero scrolls into view
  let played = false;
  const io = new IntersectionObserver((entries) => {
    if (played) return;
    if (entries.some((e) => e.isIntersecting)) {
      played = true;
      io.disconnect();
      setTimeout(play, 650);
    }
  }, { threshold: 0.45 });
  io.observe(swapArea);
})();
