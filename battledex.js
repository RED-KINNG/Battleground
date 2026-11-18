const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

function renderBattledex({ animate = true } = {}) {
  const grid = document.getElementById('battledex-grid');
  const empty = document.getElementById('battledex-empty');
  const clearBtn = document.getElementById('battledex-clear');
  const backBtn = document.getElementById('battledex-back-to-fight');
  const rosterCount = document.getElementById('roster-count-text');
  const fighters = loadBattledex();

  const count = document.createElement('strong');
  count.textContent = String(fighters.length).padStart(3, '0');
  rosterCount.replaceChildren('FIGHTERS ', count);

  grid.innerHTML = '';
  fighters.forEach((fighter, index) => {
    const card = document.createElement('figure');
    card.className = 'dex-card chamfer';
    card.style.setProperty('--i', animate ? index : 0);
    if (!animate) card.style.animation = 'none';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'dex-card-delete';
    deleteBtn.innerHTML = CLOSE_ICON;
    deleteBtn.setAttribute('aria-label', `Remove ${fighter.label}`);
    deleteBtn.addEventListener('click', () => {
      let done = false;
      const remove = () => {
        if (done) return;
        done = true;
        deleteFighter(fighter);
        renderBattledex({ animate: false });
      };
      card.classList.add('is-removing');
      card.addEventListener('animationend', remove, { once: true });
      setTimeout(remove, 350); // fallback when animations are disabled (reduced motion)
    });

    const frame = document.createElement('div');
    frame.className = 'dex-card-frame';
    const img = document.createElement('img');
    img.src = fighter.image;
    img.alt = fighter.label;
    img.loading = 'lazy';
    frame.appendChild(img);

    const caption = document.createElement('figcaption');
    caption.className = 'dex-card-caption';

    const name = document.createElement('h3');
    name.className = 'dex-card-name';
    name.textContent = fighter.label;

    const no = document.createElement('span');
    no.className = 'dex-card-no';
    no.textContent = `#${String(index + 1).padStart(3, '0')}`;

    caption.append(name, no);
    card.append(deleteBtn, frame, caption);
    grid.appendChild(card);
  });

  empty.hidden = fighters.length > 0;
  clearBtn.hidden = fighters.length === 0;
  backBtn.hidden = !loadLastFight();
}

document.getElementById('battledex-back-to-fight').addEventListener('click', () => {
  location.href = 'index.html?view=result';
});

const confirmOverlay = document.getElementById('confirm-overlay');
const clearBtn = document.getElementById('battledex-clear');

function openConfirm() {
  confirmOverlay.hidden = false;
  document.getElementById('confirm-cancel').focus();
}

function closeConfirm() {
  confirmOverlay.hidden = true;
  if (!clearBtn.hidden) clearBtn.focus();
}

clearBtn.addEventListener('click', openConfirm);
document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);

confirmOverlay.addEventListener('click', (e) => {
  if (e.target === confirmOverlay) closeConfirm();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !confirmOverlay.hidden) closeConfirm();
});

document.getElementById('confirm-delete').addEventListener('click', () => {
  saveBattledex([]);
  confirmOverlay.hidden = true;
  renderBattledex();
});

renderBattledex();
