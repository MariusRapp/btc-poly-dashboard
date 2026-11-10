// Folding: every card folds to its title row (the chevron in its corner, or a tap on the title), a KPI tile to its
// label and number. It applies to every element with class "card" and an id, so new cards get it without more code.
// A card that opens with a toolbar instead of a title row (the charts) gets a title row that only shows while folded.
// Remembered in this browser. A folded chart has no size and isn't drawn; it redraws when it unfolds.

const KEY = 'folded';
let folded = new Set();
try { const a = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(a)) folded = new Set(a); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...folded])); } catch {} };

const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';

function show(card, btn, isFolded) {
  card.classList.toggle('folded', isFolded);
  btn.setAttribute('aria-expanded', String(!isFolded));
  btn.title = (isFolded ? 'Show ' : 'Fold ') + card.dataset.fold;
  btn.setAttribute('aria-label', btn.title);
}

export function initFold() {
  for (const card of document.querySelectorAll('.card[id]')) {
    const kpi = card.classList.contains('kpi');
    let head = card.querySelector(kpi ? ':scope > .kpi-label' : ':scope > .card-head');
    if (!head) {
      head = document.createElement('div');
      head.className = 'card-head fold-head';
      head.innerHTML = '<h2></h2>';
      head.firstChild.textContent = card.getAttribute('aria-label') ?? '';
      card.prepend(head);
    }
    card.dataset.fold ||= head.querySelector('h2')?.textContent.trim() || card.getAttribute('aria-label') || 'card';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fold';
    btn.innerHTML = CHEVRON;
    card.classList.add('foldable');
    card.prepend(btn);
    const toggle = () => {
      const now = !card.classList.contains('folded');
      show(card, btn, now);
      if (now) folded.add(card.id); else folded.delete(card.id);
      save();
      // views drawn at their width (charts, the recorded-rounds charts) catch up at once
      if (!now) dispatchEvent(new Event('resize'));
    };
    btn.addEventListener('click', toggle);
    (kpi ? head : head.querySelector('h2'))?.addEventListener('click', toggle);
    show(card, btn, folded.has(card.id));
  }
}
