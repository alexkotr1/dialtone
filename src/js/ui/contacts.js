import { icon, callDirIcon } from '../icons.js';
import { clock, dayLabel, durationWords, esc, prettyNumber, sameNumber } from '../format.js';
import {
  state,
  addContact,
  updateContact,
  deleteContact,
} from '../store.js';
import { avatar } from './avatar.js';
import { modal, confirmDialog } from './modal.js';
import { toast } from './toast.js';

let root = null;
let query = '';
let selectedId = null;
let actions = {};

export function init(el, api) {
  root = el;
  actions = api;
  root.innerHTML = `
    <div class="pane">
      <div class="pane-head">
        <div class="pane-title">
          <h1>Contacts</h1>
          <button class="icon-btn" id="ctAdd" title="New contact">${icon('plus', 19)}</button>
        </div>
        <div class="search">
          ${icon('search', 15)}
          <input class="input" id="ctSearch" placeholder="Search name or number" spellcheck="false" />
        </div>
      </div>
      <div class="scroller" id="ctList"></div>
    </div>
    <div class="detail" id="ctDetail"></div>`;

  root.querySelector('#ctSearch').addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    renderList();
  });

  root.querySelector('#ctAdd').onclick = () => contactForm();

  root.querySelector('#ctList').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const contact = state.contacts.find((c) => c.id === row.dataset.id);
    if (!contact) return;
    if (e.target.closest('.quick')) {
      e.stopPropagation();
      actions.placeCall(contact.number, contact.name);
      return;
    }
    selectedId = contact.id;
    refresh();
  });

  refresh();
}

export function refresh() {
  if (!root) return;
  renderList();
  renderDetail();
}

function matches(c) {
  if (!query) return true;
  return (
    c.name.toLowerCase().includes(query) ||
    c.company.toLowerCase().includes(query) ||
    c.number.replace(/\s/g, '').includes(query.replace(/\s/g, ''))
  );
}

function renderList() {
  const list = root.querySelector('#ctList');
  const all = state.contacts.filter(matches);

  if (!all.length) {
    list.innerHTML = `
      <div class="empty" style="height:auto;padding:56px 30px">
        <div class="art">${icon('users', 28)}</div>
        <h3>${query ? 'No matches' : 'No contacts yet'}</h3>
        <p>${
          query
            ? 'Try a different name or number.'
            : 'Add someone, or save a number straight from a recent call.'
        }</p>
        ${query ? '' : `<button class="btn primary" id="ctEmptyAdd" style="margin-top:6px">${icon('plus', 15)}New contact</button>`}
      </div>`;
    list.querySelector('#ctEmptyAdd')?.addEventListener('click', () => contactForm());
    return;
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const favorites = all.filter((c) => c.favorite).sort(byName);
  const rest = all.filter((c) => !c.favorite).sort(byName);

  let html = '';
  if (favorites.length) {
    html += `<div class="section-label">Favourites</div>`;
    html += favorites.map(row).join('');
  }

  let lastLetter = '';
  for (const c of rest) {
    // Anything that doesn't start with a letter files under # rather than
    // creating a section per symbol.
    const first = (c.name[0] || '#').toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : '#';
    if (letter !== lastLetter) {
      html += `<div class="section-label">${letter}</div>`;
      lastLetter = letter;
    }
    html += row(c);
  }
  list.innerHTML = html;
}

function row(c) {
  return `
    <div class="row ${c.id === selectedId ? 'selected' : ''}" data-id="${c.id}">
      ${avatar(c.name)}
      <div class="main">
        <div class="name">${esc(c.name)}${
          c.favorite
            ? `<span style="color:var(--amber);display:inline-flex;vertical-align:-2px;margin-left:5px">${icon(
                'star',
                12,
                0
              ).replace('fill="none"', 'fill="currentColor"')}</span>`
            : ''
        }</div>
        <div class="sub">${esc(c.company ? `${c.company} · ` : '')}${esc(prettyNumber(c.number))}</div>
      </div>
      <div class="meta"></div>
      <button class="quick" title="Call ${esc(c.name)}">${icon('phone', 15, 2.2)}</button>
    </div>`;
}

function renderDetail() {
  const pane = root.querySelector('#ctDetail');
  const c = state.contacts.find((x) => x.id === selectedId);

  if (!c) {
    pane.innerHTML = `
      <div class="detail-empty">
        <div class="art">${icon('users', 28)}</div>
        <h3>Select a contact</h3>
        <p>Pick someone to see their number, notes, and your call history together.</p>
      </div>`;
    return;
  }

  const related = state.history.filter((h) => sameNumber(h.number, c.number));

  pane.innerHTML = `
    <div class="detail-card">
      ${avatar(c.name, { size: 'lg' })}
      <h2>${esc(c.name)}</h2>
      ${c.company ? `<div class="num">${esc(c.company)}</div>` : ''}
      <div class="num">${esc(prettyNumber(c.number))}</div>
      <div class="detail-actions">
        <button class="action call" data-act="call">
          <span class="ring">${icon('phone', 18, 2.1)}</span>Call
        </button>
        <button class="action" data-act="fav">
          <span class="ring" style="${
            c.favorite ? 'background:var(--amber-soft);border-color:transparent;color:var(--amber)' : ''
          }">${icon('star', 17)}</span>${c.favorite ? 'Favourite' : 'Add star'}
        </button>
        <button class="action" data-act="edit">
          <span class="ring">${icon('edit', 17)}</span>Edit
        </button>
        <button class="action danger" data-act="delete">
          <span class="ring">${icon('trash', 17)}</span>Delete
        </button>
      </div>
    </div>

    ${
      c.note
        ? `<div class="detail-section">
             <h4>Notes</h4>
             <p style="margin:0;color:var(--text-2);line-height:1.6;user-select:text;white-space:pre-wrap">${esc(
               c.note
             )}</p>
           </div>`
        : ''
    }

    <div class="detail-section">
      <h4>Recent calls (${related.length})</h4>
      ${
        related.length
          ? `<div class="timeline">${related
              .slice(0, 30)
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
              .join('')}</div>`
          : `<p style="margin:0;color:var(--text-3);font-size:13px">No calls with ${esc(
              c.name
            )} yet.</p>`
      }
    </div>`;

  pane.querySelector('[data-act="call"]').onclick = () => actions.placeCall(c.number, c.name);
  pane.querySelector('[data-act="fav"]').onclick = () => {
    updateContact(c.id, { favorite: !c.favorite });
    refresh();
  };
  pane.querySelector('[data-act="edit"]').onclick = () => contactForm(c);
  pane.querySelector('[data-act="delete"]').onclick = async () => {
    const ok = await confirmDialog({
      title: `Delete ${c.name}?`,
      message: 'This removes the contact. Calls with this number stay in your history.',
    });
    if (ok) {
      deleteContact(c.id);
      selectedId = null;
      refresh();
      toast(`${c.name} deleted`);
    }
  };
}

/** Add or edit. One form for both, because they differ only in defaults. */
async function contactForm(existing = null, prefillNumber = '') {
  const c = existing || { name: '', number: prefillNumber, company: '', note: '', favorite: false };
  const result = await modal({
    title: existing ? 'Edit contact' : 'New contact',
    confirmText: existing ? 'Save changes' : 'Add contact',
    body: `
      <div class="field">
        <label for="cfName">Name</label>
        <input class="input" id="cfName" value="${esc(c.name)}" placeholder="Jane Smith" />
      </div>
      <div class="field">
        <label for="cfNumber">Number or extension</label>
        <input class="input" id="cfNumber" value="${esc(c.number)}" placeholder="1001 or +30 211 444 3742" />
      </div>
      <div class="field">
        <label for="cfCompany">Company <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <input class="input" id="cfCompany" value="${esc(c.company)}" />
      </div>
      <div class="field">
        <label for="cfNote">Notes <span style="font-weight:400;color:var(--text-3)">(optional)</span></label>
        <textarea class="input" id="cfNote" rows="3" style="height:auto;padding:9px 12px;resize:vertical">${esc(
          c.note
        )}</textarea>
      </div>`,
    onConfirm: (r) => {
      const name = r.querySelector('#cfName').value.trim();
      const number = r.querySelector('#cfNumber').value.trim();
      if (!name) {
        toast('A name is required.', 'error');
        return null;
      }
      if (!number) {
        toast('A number is required.', 'error');
        return null;
      }
      return {
        name,
        number,
        company: r.querySelector('#cfCompany').value.trim(),
        note: r.querySelector('#cfNote').value.trim(),
      };
    },
  });

  if (!result) return;
  if (existing) {
    updateContact(existing.id, result);
    toast('Contact updated', 'ok');
  } else {
    const created = addContact({ ...result, favorite: c.favorite });
    selectedId = created.id;
    toast(`${created.name} added`, 'ok');
  }
  refresh();
}

/** Entry point for "add this number as a contact" from another view. */
export function newContactFor(number) {
  contactForm(null, number);
}

export function select(contactId) {
  selectedId = contactId;
  refresh();
}
