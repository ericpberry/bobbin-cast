// Page Reader's TV page (SPEC.md C2, C4; the repo and the Cast namespace keep the name bobbin). Plays each chunk's audio from the phone and draws the text being read with both
// highlight layers, from the page's own audio clock. Messages on urn:x-cast:app.bobbin, mirrored in
// core/src/main/kotlin/app/bobbin/core/cast/TvMessages.kt:
//   doc     phone → TV  the item's outline: id, title, site, sections [{title, ms}], speed, next
//   chunk   phone → TV  the chunk's text, sentences and words [{start, end, from, to}], section, progress
//   status  phone → TV  speed, paused, voicing
//   end     phone → TV  the item finished; next
//   want / ended / next / previous / toggle   TV → phone
// Cast handling from Spool's receiver (ericpberry/spool@d33f07b, receiver/receiver.js): the page decides when a chunk
// starts from its own player and asks for it by id (D-113); a finish counts only if it holds 2 s (D-114); it answers
// only the sender that last spoke (D-120); touch comes from device capabilities, not viewport size (D-113).
(() => {
  const NAMESPACE = "urn:x-cast:app.bobbin";
  const params = new URLSearchParams(location.search);
  const PREVIEW = params.get("preview");
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // The 960 x 540 design, scaled to the screen (1920 x 1080 on most TVs).
  function fit() {
    const s = Math.min(innerWidth / 960, innerHeight / 540);
    const st = $("stage");
    st.style.transform = `scale(${s})`;
    st.style.left = `${(innerWidth - 960 * s) / 2}px`;
    st.style.top = `${(innerHeight - 540 * s) / 2}px`;
  }
  addEventListener("resize", fit);
  fit();

  let context = null;
  let player = null;
  if (!PREVIEW) {
    context = cast.framework.CastReceiverContext.getInstance();
    player = context.getPlayerManager();
    player.setMediaElement($("audio"));
  }
  /** Milliseconds into the playing chunk; in preview, a clock that loops. */
  // ?preview=still freezes the clock on the mockup's moment ("memory" being spoken).
  const now = () => (player ? player.getCurrentTimeSec() * 1000 : PREVIEW === "still" ? 4100 : (Date.now() % 9000));

  let doc = null;       // the last doc message
  let chunk = null;     // the chunk being shown
  let playingId = null; // the playlist item the TV is playing (D-113)
  let endedFor = null;  // the item whose finish was already reported
  let speed = 1;
  let voicing = false;
  let sentences = [];   // [{ el, start, end }]
  let words = [];       // [{ el, start, end }]
  let screen = "idle";

  function show(name) {
    screen = name;
    for (const id of ["idle", "reading", "end"]) $(id).hidden = id !== name;
  }

  // D-120: the phone is the sender that last spoke on the channel; until it has (or if it's gone), every sender.
  let phone = null;
  function ask(type, extra) {
    const msg = Object.assign({ type }, extra || {});
    if (!context) return console.log("ask", msg);
    const to = phone && context.getSenders().some((s) => s.id === phone) ? phone : undefined;
    context.sendCustomMessage(NAMESPACE, to, msg);
  }

  // ---- drawing ------------------------------------------------------------------------------------------------------

  function minutes(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  }

  function renderDoc(m) {
    doc = m;
    speed = m.speed || speed;
    $("title").textContent = m.title || "";
    const box = $("contents");
    box.replaceChildren(...(m.sections || []).map((s) => el("div", null, s.title)));
    $("nextBox").hidden = !m.next;
    $("next").textContent = m.next || "";
    const bar = $("bar");
    bar.replaceChildren(...(m.sections || []).map((s) => {
      const seg = el("div");
      seg.style.flex = String(Math.max(1, s.ms));
      seg.appendChild(el("div"));
      return seg;
    }));
    drawStatus();
    if (screen !== "reading") show("reading");
  }

  /** The chunk's text as sentence spans holding word spans, so both highlight layers are CSS classes. */
  function renderChunk(m) {
    chunk = m;
    const text = m.text || "";
    const p = $("text");
    p.replaceChildren();
    sentences = [];
    words = [];
    let at = 0;
    for (const s of m.sentences || []) {
      if (s.from > at) p.append(text.slice(at, s.from));
      const se = el("span", "s");
      let i = s.from;
      for (const w of (m.words || []).filter((w) => w.from >= s.from && w.to <= s.to)) {
        if (w.from > i) se.append(text.slice(i, w.from));
        const we = el("span", "w", text.slice(w.from, w.to));
        se.append(we);
        words.push({ el: we, start: w.start, end: w.end });
        i = w.to;
      }
      if (s.to > i) se.append(text.slice(i, s.to));
      p.append(se);
      sentences.push({ el: se, start: s.start, end: s.end });
      at = s.to;
    }
    if (at < text.length) p.append(text.slice(at));
    for (const [i, d] of [...$("contents").children].entries()) d.classList.toggle("now", i === m.section);
    // A long Contents scrolls (it is cut at its box): keep the section being read in the middle of what shows.
    const box = $("contents"), now = box.querySelector(".now");
    if (now) box.scrollTop = Math.max(0, now.offsetTop - box.offsetTop - (box.clientHeight - now.offsetHeight) / 2);
    if (screen !== "reading") show("reading");
    drawStatus();
  }

  function drawStatus() {
    $("speed").textContent = `${Number(speed).toFixed(speed % 1 ? 2 : 1).replace(/0$/, "")}×${voicing ? " · voicing…" : ""}`;
  }

  /** Every frame: the spoken sentence and word from the page's own audio clock, the meta line, and the bar. */
  let lastSecond = -1;
  function tick() {
    requestAnimationFrame(tick);
    if (screen !== "reading" || !chunk) return;
    const t = now();
    let si = -1;
    for (let i = 0; i < sentences.length; i++) if (sentences[i].start <= t) si = i;
    if (si < 0 && sentences.length) si = 0;
    sentences.forEach((s, i) => s.el.classList.toggle("now", i === si));
    let wi = -1;
    for (let i = 0; i < words.length; i++) if (words[i].start <= t && t < words[i].end + 60) wi = i;
    words.forEach((w, i) => w.el.classList.toggle("now", i === wi));
    const sec = Math.floor(t / 1000);
    if (sec === lastSecond) return;
    lastSecond = sec;
    const pr = chunk.progress || { heardMs: 0, totalMs: 0 };
    const heard = pr.heardMs + t;
    const parts = [doc && doc.site, doc && doc.sections && doc.sections.length > 1 ? `Section ${chunk.section + 1} of ${doc.sections.length}` : null,
      pr.totalMs ? `${minutes((pr.totalMs - heard) / (speed || 1))} left` : null].filter(Boolean);
    $("meta").textContent = parts.join(" · ");
    let start = 0;
    for (const [i, seg] of [...$("bar").children].entries()) {
      const ms = doc.sections[i].ms;
      const f = ms > 0 ? Math.min(1, Math.max(0, (heard - start) / ms)) : (i < chunk.section ? 1 : 0);
      seg.firstChild.style.width = `${(i < chunk.section ? 1 : i > chunk.section ? 0 : f) * 100}%`;
      start += ms;
    }
  }
  requestAnimationFrame(tick);

  function renderEnd(m) {
    $("endTitle").textContent = doc ? doc.title : "";
    $("endNext").hidden = !m.next;
    $("endNextTitle").textContent = m.next || "";
    show("end");
  }

  function setPaused(paused) {
    $("paused").hidden = !paused;
    const pp = document.querySelector("#touch .pp");
    pp.textContent = paused ? "▶" : "❚❚";
    pp.setAttribute("aria-label", paused ? "Play" : "Pause");
  }

  function onMessage(m) {
    if (!m || !m.type) return;
    if (m.type === "doc") renderDoc(m);
    else if (m.type === "chunk") { if (!playingId || m.id === playingId) renderChunk(m); }
    else if (m.type === "status") { speed = m.speed; voicing = !!m.voicing; setPaused(!!m.paused); drawStatus(); }
    else if (m.type === "end") renderEnd(m);
  }

  // ---- input: TV remote keys, smart display touch -------------------------------------------------------------------

  let lastKey = 0;
  document.addEventListener("keydown", (e) => {
    // Held keys repeat and some remotes send a key twice: one step per press, at most every 0.7 s (D-113).
    if (e.repeat || Date.now() - lastKey < 700) return;
    lastKey = Date.now();
    if (screen !== "reading") return;
    if (e.key === "ArrowRight") ask("next");
    else if (e.key === "ArrowLeft") ask("previous");
    else if (e.key === "Enter" || e.key === "Select" || e.key === "Accept" || e.key === "MediaPlayPause") ask("toggle");
  });
  for (const b of document.querySelectorAll("#touch button")) b.addEventListener("click", () => ask(b.dataset.ask));

  // ---- start --------------------------------------------------------------------------------------------------------

  if (PREVIEW) { preview(PREVIEW); return; }
  context.addCustomMessageListener(NAMESPACE, (event) => {
    let m = event.data;
    if (typeof m === "string") { try { m = JSON.parse(m); } catch (e) { return; } }
    if (event.senderId) phone = event.senderId;
    onMessage(m);
  });
  const Events = cast.framework.events.EventType;
  player.addEventListener(Events.PAUSE, () => setPaused(true));
  for (const ev of [Events.PLAY, Events.PLAYING]) player.addEventListener(ev, () => setPaused(false));

  // D-113: the TV, not the phone, knows when a chunk starts and when the last one ends. A new chunk asks the phone for
  // its text; the old chunk's highlight stays until the new text arrives, so the screen never goes blank mid-read.
  function onStatus() {
    const media = player.getMediaInformation();
    const id = media && media.customData && media.customData.mediaId;
    if (id && id !== playingId) {
      playingId = id;
      endedFor = null;
      lastSecond = -1;
      ask("want", { id });
    }
  }
  player.addEventListener(Events.PLAYER_LOAD_COMPLETE, onStatus);
  player.addEventListener(Events.MEDIA_STATUS, (e) => {
    onStatus();
    const st = e.mediaStatus;
    if (st && st.playerState === "IDLE" && st.idleReason === "FINISHED" && endedFor !== playingId) {
      // D-114: skipping reports the skipped chunk as finished for a moment before the next loads. Only a finish still
      // true 2 s later, with the same chunk, is the end of the queue.
      const was = playingId;
      setTimeout(() => {
        const idle = player.getPlayerState() === cast.framework.messages.PlayerState.IDLE;
        if (idle && playingId === was && endedFor !== was) { endedFor = was; ask("ended"); }
      }, 2000);
    }
  });
  // Touch screens (Nest Hub) get buttons; TVs, whatever their viewport, get the side column and the remote.
  context.addEventListener(cast.framework.system.EventType.READY, () => {
    const caps = (context.getDeviceCapabilities && context.getDeviceCapabilities()) || {};
    const System = cast.framework.system;
    const touchKey = System.DeviceCapabilities && System.DeviceCapabilities.TOUCH_INPUT_SUPPORTED;
    const touch = (touchKey && caps[touchKey]) || caps.touch_input_supported;
    document.body.classList.toggle("touch", !!touch);
  });
  const Command = cast.framework.messages.Command;
  player.setSupportedMediaCommands(Command.ALL_BASIC_MEDIA | Command.QUEUE_NEXT | Command.QUEUE_PREV, true);
  context.start({ disableIdleTimeout: true });

  // ---- preview (a browser, no Cast): the TV mockup's own content ----------------------------------------------------

  function preview(state) {
    if (params.get("touch") === "1") document.body.classList.add("touch");
    if (state === "idle") return show("idle");
    // &sections=N gives a long Contents (a book), &current=K puts the reading there (TvContentsTest, a lab finding).
    const many = Number(params.get("sections") || 0);
    const current = Number(params.get("current") || 1);
    const sections = many > 0
      ? Array.from({ length: many }, (_, i) => ({ title: `Chapter ${i + 1}: A long chapter title that runs past the column`, ms: 200000 }))
      : [["Introduction", 140000], ["The memory in the mud", 220000], ["Reading the floodplain", 300000], ["What the maps miss", 180000], ["Letting the river back in", 160000]]
        .map(([title, ms]) => ({ title, ms }));
    renderDoc({ type: "doc", id: "doc:1", title: "How rivers remember their old paths", site: "harborreview.org", speed: 1.25, next: "Q3 Board Packet",
      sections });
    const a = "These scars are not just history.";
    const b = "Hydrologists call this channel memory, and it is one reason a river can leave its banks where every map looked safe.";
    const text = `${a} ${b}`;
    const ws = [];
    let t = 2600;
    for (const m of b.matchAll(/\S+/g)) {
      const from = a.length + 1 + m.index;
      const w = m[0].replace(/[,.]$/, "");
      ws.push({ start: t, end: t + 340, from, to: from + w.length });
      t += 360;
    }
    renderChunk({ type: "chunk", id: "doc:1#12", section: many > 0 ? current : 1, text,
      sentences: [{ start: 0, end: 2400, from: 0, to: a.length }, { start: 2600, end: t, from: a.length + 1, to: text.length }],
      words: ws, progress: { heardMs: 140000 + 99000, totalMs: 1000000 } });
    if (state === "paused") setPaused(true);
    if (state === "end") renderEnd({ type: "end", next: "Q3 Board Packet" });
  }
})();
