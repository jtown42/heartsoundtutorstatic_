(async function () {
  // URL bits
  const parts = location.pathname.split('/');
  const itemId = parts[parts.length - 1];
  const params = new URLSearchParams(location.search);
  const blind = params.get('blind') === '1';  // hide title only when coming from Random

  // DOM
  const chat = document.getElementById('chat');
  const titleEl = document.getElementById('case-title');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const hintBtn = document.getElementById('btn-hint');
  const revealBtn = document.getElementById('btn-reveal');
  const nextBtn = document.getElementById('btn-next');

  // helpers
  function bubble(role, html) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    wrap.innerHTML = html;
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return wrap;
  }
  function bubbleAudio(src) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = src;
    wrap.appendChild(audio);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    audio.play().catch(()=>{});
    return wrap;
  }

  // Detect server mode
  let isMock = false;
  try {
    const h = await fetch('/health').then(r=>r.json());
    isMock = (h && h.ai_mode === 'mock');
  } catch (_) {}

  // load item + all items (for next random)
  let item = null, allItems = [];
  try {
    const resp = await fetch('/static/data/murmurs.json?v=' + Date.now());
    const data = await resp.json();
    allItems = data.items || [];
    item = allItems.find(it => (it.id || '').toLowerCase() === itemId.toLowerCase())
        || allItems.find(it => (it.title||'').toLowerCase().replace(/[^a-z0-9]+/g,'-') === itemId.toLowerCase());
  } catch (e) { console.error(e); }

  if (!item) {
    bubble('assistant', 'Could not find that case. <a href="/">Go back to catalog</a>.');
    if (titleEl) titleEl.textContent = 'Case not found';
    form?.remove();
    return;
  }

  const trueTitle = item.title || 'Unknown murmur';

  // choose audio variant (if provided)
  const variants = Array.isArray(item.files) && item.files.length
    ? item.files.slice()
    : (item.file ? [item.file] : []);
  let chosenIdx = variants.length ? Math.floor(Math.random() * variants.length) : 0;
  let chosenFile = variants.length ? variants[chosenIdx] : null;

  // Title behavior
  if (blind) {
    if (titleEl) titleEl.textContent = 'Identify the murmur';
  } else {
    if (titleEl) titleEl.textContent = trueTitle;
  }

  // flow state + MCQ counters
  let state = 'intro';
  let attempts = 0;
  let hintLevel = 0;
  let thread = [];

  // Hide chat form in mock mode (use buttons-only UX)
  if (isMock && form) {
    form.style.display = 'none';
  }

  // Choices currently on screen (for keyboard A/B/C/D in future)
  let currentChoices = null;

  // Render MCQ buttons bubble (replaces previous choices bubble)
  function renderChoices(choices) {
    currentChoices = choices;
    if (!choices || !choices.length) return;

    // Remove any previous choices bubble to avoid stacking
    const old = chat.querySelector('.msg.assistant[data-choices="1"]');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.dataset.choices = '1';

    const box = document.createElement('div');
    box.style.display = 'grid';
    box.style.gridTemplateColumns = '1fr 1fr';
    box.style.gap = '.5rem';

    choices.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = `${opt.key}. ${opt.label}`;
      btn.style.textAlign = 'left';
      btn.onclick = async (e) => {
        e.preventDefault();
        // keep transcript clean: don't echo a user bubble for MCQ clicks
        const next = await turn({ state, user_msg: `choice ${opt.key}`, choice_key: opt.key });
        afterTurn(next);
      };
      box.appendChild(btn);
    });

    wrap.appendChild(box);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  // server turn helper (allows overriding first audio variant)
  async function turn(payload, opts = {}) {
    const sendItem = opts.overrideFile ? { ...item, file: opts.overrideFile } : item;
    const res = await fetch('/case_api', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        ...payload,
        item: sendItem,
        attempts,
        hint_level: hintLevel
      })
    });
    const data = await res.json();
    if (data.error) { bubble('assistant', 'Tutor error: ' + data.error); return null; }
    if (data.text) bubble('assistant', data.text);
    if (data.audio) bubbleAudio(data.audio);
    if (Array.isArray(data.choices)) renderChoices(data.choices);
    // sync counters/state if server returned them
    if (Number.isInteger(data.attempts)) attempts = data.attempts;
    if (Number.isInteger(data.hint_level)) hintLevel = data.hint_level;
    return data;
  }

  // Process a server response uniformly
  function afterTurn(next) {
    if (!next) return;
    if (next.next_state) state = next.next_state;

    // If we were blind and we reached wrap (correct or reveal), show title + more examples
    if (state === 'wrap' && blind && titleEl) {
      titleEl.textContent = trueTitle;
      showMoreExamples();
    }
  }

  // intro: plays chosen variant + server payload (MCQ or tutor text)
  const first = await turn({ state }, { overrideFile: chosenFile });
  afterTurn(first);

  // show more examples (other variants) — used after wrap
  function showMoreExamples() {
    if (!variants.length) return;
    const rest = variants.filter((_, idx) => idx !== chosenIdx);
    if (!rest.length) return;

    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const h = document.createElement('div');
    h.innerHTML = '<strong>More examples of the same murmur</strong>';
    wrap.appendChild(h);

    rest.forEach(src => {
      const row = document.createElement('div');
      row.style.marginTop = '6px';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = src;
      row.appendChild(audio);
      wrap.appendChild(row);
    });

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  // Text submit: live mode uses chat; mock mode usually doesn't show this form
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = (input.value || '').trim();
    if (!q) return;
    input.value = '';
    bubble('user', q);
    thread.push({role:'user', content:q});

    const next = await turn({ state, user_msg: q, thread });
    afterTurn(next);
  });

  // Hint button: works in both modes (sends 'hint')
  if (hintBtn) {
    hintBtn.onclick = async (e) => {
      e.preventDefault();
      const next = await turn({ state, user_msg: 'hint' });
      afterTurn(next);
    };
  }

  // Reveal button: explicitly ask for the answer; in mock, it will show wrap
  if (revealBtn) {
    revealBtn.onclick = async (e) => {
      e.preventDefault();
      const res = await turn({ state, user_msg: 'reveal' });
      afterTurn(res);
    };
  }

  // Next random
  if (nextBtn) {
    nextBtn.onclick = (e) => {
      e.preventDefault();
      if (!allItems.length) return;
      const rand = allItems[Math.floor(Math.random() * allItems.length)];
      const id = (rand.id || rand.title.toLowerCase().replace(/[^a-z0-9]+/g,'-'));
      location.href = `/case/${id}?blind=1`;
    };
  }

  // MOCK badge if applicable
  if (isMock) {
    const tag = document.createElement('div');
    tag.textContent = 'MOCK MODE — no API used';
    tag.style = 'position:fixed;top:8px;right:8px;background:#fde68a;border:1px solid #f59e0b;color:#78350f;padding:6px 10px;border-radius:8px;font:12px system-ui;z-index:9999';
    document.body.appendChild(tag);
  }
})();
