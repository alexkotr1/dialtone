import { icon, callDirIcon } from '../icons.js';
import {
  clock,
  dayLabel,
  durationWords,
  esc,
  prettyNumber,
  sameNumber,
  shortStamp,
} from '../format.js';
import { state, deleteCall, clearHistory, addContact } from '../store.js';
import { avatar } from './avatar.js';
import { modal, confirmDialog } from './modal.js';
import { toast } from './toast.js';

let root = null;
let filter = 'all';
let selectedId = null;
let actions = {};

export function init(el, api) {
  root = el;
  actions = api;
  root.innerHTML = `
    <div class="pane">
      <div class="pane-head">
        <div class="pane-title">
          <h1>Recents</h1>
          <button class="icon-btn" id="recClear" title="Clear all">${icon('trash', 17)}</button>
        </div>
        <div class="chips">
          <button class="chip active" data-filter="all">All</button>
          <button class="chip" data-filter="missed">Missed</button>
        </div>
      </div>
      <div class="scroller" id="recList"></div>
    </div>
    <div class="detail" id="recDetail"></div>`;

  root.querySelector('.chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    root.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    refresh();
  });

  root.querySelector('#recClear').onclick = async () => {
    if (!state.history.length) return;
    const ok = await confirmDialog({
      title: 'Clear call history?',
      message: `This permanently deletes all ${state.history.length} entries. It cannot be undone.`,
      confirmText: 'Clear all',
    });
    if (ok) {
      clearHistory();
      selectedId = null;
      toast('Call history cleared');
    }
  };

  root.querySelector('#recList').addEventListener('click', (e) => {
    const quick = e.target.closest('.quick');
    const row = e.target.closest('.row');
    if (!row) return;
    const entry = state.history.find((h) => h.id === row.dataset.id);
    if (!entry) return;
    if (quick) {
      e.stopPropagation();
      actions.placeCall(entry.number, entry.name);
      return;
    }
    selectedId = entry.id;
    refresh();
  });

  refresh();
}

function visible() {
  return filter === 'missed'
    ? state.history.filter((h) => h.direction === 'missed')
    : state.history;
}

export function refresh() {
  if (!root) return;
  renderList();
  renderDetail();
}

function renderList() {
  const list = root.querySelector('#recList');
  const items = visible();

  if (!items.length) {
    list.innerHTML = `
      <div class="empty" style="height:auto;padding:60px 30px">
        <div class="art">${icon('clock', 28)}</div>
        <h3>${filter === 'missed' ? 'No missed calls' : 'No calls yet'}</h3>
        <p>${
          filter === 'missed'
            ? 'Calls you did not pick up will appear here.'
            : 'Calls you make and receive will appear here.'
        }</p>
      </div>`;
    return;
  }

  let html = '';
  let lastDay = '';
  for (const h of items) {
    const day = dayLabel(h.startedAt);
    if (day !== lastDay) {
      html += `<div class="section-label">${esc(day)}</div>`;
      lastDay = day;
    }
    const contact = state.contacts.find((c) => sameNumber(c.number, h.number));
    const title = contact?.name || h.name || prettyNumber(h.number) || 'Unknown';
    const missed = h.direction === 'missed';
    const dirColor = missed ? 'var(--red)' : 'var(--text-3)';

    html += `
      <div class="row ${h.id === selectedId ? 'selected' : ''}" data-id="${h.id}">
        ${avatar(contact?.name || h.name, { seed: contact?.name || h.number })}
        <div class="main">
          <div class="name ${missed ? 'missed' : ''}">${esc(title)}</div>
          <div class="sub">
            <span style="color:${dirColor};display:flex">${callDirIcon(h.direction, 13)}</span>
            ${esc(missed ? 'Missed' : h.duration ? durationWords(h.duration) : 'No answer')}
            ${contact || h.name ? `<span>· ${esc(prettyNumber(h.number))}</span>` : ''}
          </div>
        </div>
        <div class="meta">${esc(shortStamp(h.startedAt))}</div>
        <button class="quick" title="Call back">${icon('phone', 15, 2.2)}</button>
      </div>`;
  }
  list.innerHTML = html;
}

function renderDetail() {
  const pane = root.querySelector('#recDetail');
  const entry = state.history.find((h) => h.id === selectedId);

  if (!entry) {
    pane.innerHTML = `
      <div class="detail-empty">
        <div class="art">${icon('clock', 28)}</div>
        <h3>Select a call</h3>
        <p>Pick an entry to see its details and everything else from that number.</p>
      </div>`;
    return;
  }

  const contact = state.contacts.find((c) => sameNumber(c.number, entry.number));
  const title = contact?.name || entry.name || prettyNumber(entry.number) || 'Unknown';
  // Every call with this number, so the detail pane answers "how often do we
  // talk?" rather than just repeating the row that was clicked.
  const related = state.history.filter((h) => sameNumber(h.number, entry.number));

  pane.innerHTML = `
    <div class="detail-card">
      ${avatar(contact?.name || entry.name, { size: 'lg', seed: contact?.name || entry.number })}
      <h2>${esc(title)}</h2>
      ${contact || entry.name ? `<div class="num">${esc(prettyNumber(entry.number))}</div>` : ''}
      <div class="detail-actions">
        <button class="action call" data-act="call">
          <span class="ring">${icon('phone', 18, 2.1)}</span>Call
        </button>
        ${
          contact
            ? `<button class="action" data-act="viewContact">
                 <span class="ring">${icon('user', 18)}</span>Contact
               </button>`
            : `<button class="action" data-act="addContact">
                 <span class="ring">${icon('plus', 18)}</span>Add
               </button>`
        }
        <button class="action danger" data-act="delete">
          <span class="ring">${icon('trash', 17)}</span>Delete
        </button>
      </div>
    </div>

    <div class="detail-section">
      <h4>History with this number (${related.length})</h4>
      <div class="timeline">
        ${related
          .slice(0, 40)
          .map(
            (h) => `
          <div class="item">
            <span style="color:${
              h.direction === 'missed' ? 'var(--red)' : 'var(--text-3)'
            };display:flex">${callDirIcon(h.direction, 14)}</span>
            <span class="when">${esc(dayLabel(h.startedAt))} at ${esc(clock(h.startedAt))}</span>
            <span class="dur">${esc(h.duration ? durationWords(h.duration) : '—')}</span>
          </div>`
          )
          .join('')}
      </div>
    </div>`;

  pane.querySelector('[data-act="call"]').onclick = () =>
    actions.placeCall(entry.number, contact?.name || entry.name);

  pane.querySelector('[data-act="delete"]').onclick = () => {
    deleteCall(entry.id);
    selectedId = null;
    refresh();
  };

  pane.querySelector('[data-act="viewContact"]')?.addEventListener('click', () =>
    actions.openContact(contact.id)
  );

  pane.querySelector('[data-act="addContact"]')?.addEventListener('click', async () => {
    const result = await modal({
      title: 'New contact',
      confirmText: 'Add contact',
      body: `
        <div class="field">
          <label for="ncName">Name</label>
          <input class="input" id="ncName" placeholder="Jane Smith" />
        </div>
        <div class="field">
          <label for="ncNumber">Number</label>
          <input class="input" id="ncNumber" value="${esc(entry.number)}" />
        </div>`,
      onConfirm: (r) => {
        const name = r.querySelector('#ncName').value.trim();
        const number = r.querySelector('#ncNumber').value.trim();
        if (!name || !number) {
          toast('A name and a number are both required.', 'error');
          return null;
        }
        return { name, number };
      },
    });
    if (result) {
      addContact(result);
      toast(`${result.name} added to contacts`, 'ok');
      refresh();
    }
  });
}

/** Focus a specific number's most recent call — used when arriving from
 *  elsewhere in the app. */
export function selectNumber(number) {
  const entry = state.history.find((h) => sameNumber(h.number, number));
  selectedId = entry?.id || null;
  refresh();
}
