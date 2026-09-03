/**
 * vCard reader, for importing a phone's address book.
 *
 * Written against what Apple actually exports, which is vCard 3.0 with a
 * handful of habits a naive line-splitter gets wrong:
 *
 *   Folding      - a long line continues on the next one, marked by a leading
 *                  space or tab. Split first and you get half a name and a
 *                  stray fragment that looks like a second contact.
 *   Groups       - properties arrive as `item1.TEL` with the human label in a
 *                  matching `item1.X-ABLabel`. That is where "iPhone", "Home"
 *                  and any custom label live.
 *   Photos       - PHOTO is a base64 blob folded across dozens of lines. It
 *                  has to be skipped without being mistaken for data.
 *   Escapes      - commas, semicolons and newlines inside a value are
 *                  backslash-escaped and have to be put back.
 *   Encodings    - Apple writes UTF-8, but Android and older exports use
 *                  quoted-printable, which turns a Greek name into a run of
 *                  =CE=91 sequences unless it is decoded.
 *
 * One number per Dialtone contact, because that is what a Dialtone contact
 * holds. A person with a mobile and a landline becomes two entries, labelled,
 * rather than one entry that silently drops a number.
 */

/** Undo RFC 6350 line folding, then split into logical lines. */
function unfold(text) {
  const out = [];
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Decode `=CE=91` style escapes. Soft line breaks are already unfolded. */
function decodeQuotedPrintable(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && i + 2 < s.length && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return s;
  }
}

/** Put back the characters vCard escapes inside a value. */
function unescapeValue(s) {
  return s.replace(/\\([\\,;nN])/g, (_, c) =>
    c === 'n' || c === 'N' ? '\n' : c);
}

/**
 * Split one logical line into its parts.
 * `item1.TEL;type=CELL;type=pref:+30 697 ...`
 */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  let value = line.slice(colon + 1);

  const bits = head.split(';');
  let name = bits[0];
  let group = '';
  const dot = name.indexOf('.');
  if (dot > 0) {
    group = name.slice(0, dot);
    name = name.slice(dot + 1);
  }

  const params = {};
  for (const p of bits.slice(1)) {
    const eq = p.indexOf('=');
    // A bare `;HOME` is legal vCard 2.1 shorthand for `;TYPE=HOME`.
    const key = (eq < 0 ? 'TYPE' : p.slice(0, eq)).toUpperCase();
    const val = (eq < 0 ? p : p.slice(eq + 1)).replace(/^"|"$/g, '');
    if (params[key]) params[key] += ',' + val;
    else params[key] = val;
  }

  if ((params.ENCODING || '').toUpperCase().includes('QUOTED-PRINTABLE')) {
    value = decodeQuotedPrintable(value);
  }
  return { name: name.toUpperCase(), group, params, value };
}

/** Phone number as Dialtone stores it: dialable characters only. */
function cleanNumber(raw) {
  const s = String(raw).replace(/[^\d+*#]/g, '');
  // A plus is only meaningful leading the number.
  return s.startsWith('+') ? '+' + s.slice(1).replace(/\+/g, '') : s.replace(/\+/g, '');
}

/** Human label for a number, from its TYPE params or its X-ABLabel. */
function labelFor(params, abLabel) {
  if (abLabel) {
    // Apple wraps custom labels: _$!<Home>!$_
    const m = abLabel.match(/_\$!<(.+?)>!\$_/);
    return (m ? m[1] : abLabel).trim();
  }
  const types = (params.TYPE || '')
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t && t !== 'VOICE' && t !== 'PREF' && t !== 'INTERNET');
  if (!types.length) return '';
  const first = types[0];
  const pretty = {
    CELL: 'mobile',
    IPHONE: 'iPhone',
    HOME: 'home',
    WORK: 'work',
    MAIN: 'main',
    FAX: 'fax',
    HOMEFAX: 'home fax',
    WORKFAX: 'work fax',
    PAGER: 'pager',
    OTHER: 'other',
  };
  return pretty[first] || first.toLowerCase();
}

/**
 * Parse a .vcf file into Dialtone contacts.
 *
 * @param {string} text
 * @returns {{contacts: Array<{name:string,number:string,company:string,note:string,favorite:boolean}>,
 *            cards: number, skipped: number}}
 *   `skipped` counts cards with no usable phone number - an email-only
 *   contact is not an error, but the count is worth showing so a person who
 *   expected 400 and got 380 knows why.
 */
export function parseVCards(text) {
  const contacts = [];
  let cards = 0;
  let skipped = 0;

  let card = null;
  let inPhoto = false;

  const flush = () => {
    if (!card) return;
    cards++;
    const name =
      card.fn ||
      [card.given, card.family].filter(Boolean).join(' ').trim() ||
      card.org ||
      (card.tels[0] ? card.tels[0].number : '');
    if (!card.tels.length) {
      skipped++;
      card = null;
      return;
    }
    // Label the numbers only when there is more than one, so the common case
    // stays a plain name.
    const many = card.tels.length > 1;
    for (const tel of card.tels) {
      const label = many ? labelFor(tel.params, card.labels[tel.group]) : '';
      contacts.push({
        name: label ? `${name} (${label})` : name || tel.number,
        number: tel.number,
        company: card.org || '',
        note: card.note || '',
        favorite: false,
      });
    }
    card = null;
  };

  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:VCARD')) {
      card = { fn: '', given: '', family: '', org: '', note: '', tels: [], labels: {} };
      inPhoto = false;
      continue;
    }
    if (upper.startsWith('END:VCARD')) {
      flush();
      continue;
    }
    if (!card) continue;

    // A folded base64 photo arrives as one enormous logical line after
    // unfolding, so this mostly guards malformed files that fold badly.
    if (inPhoto) {
      if (!/^[A-Za-z0-9+/=\s]*$/.test(line)) inPhoto = false;
      else continue;
    }

    const p = parseLine(line);
    if (!p) continue;

    switch (p.name) {
      case 'PHOTO':
      case 'LOGO':
        inPhoto = true;
        break;
      case 'FN':
        card.fn = unescapeValue(p.value).trim();
        break;
      case 'N': {
        const parts = p.value.split(';').map((x) => unescapeValue(x).trim());
        card.family = parts[0] || '';
        card.given = parts[1] || '';
        break;
      }
      case 'ORG':
        card.org = unescapeValue(p.value.split(';')[0] || '').trim();
        break;
      case 'NOTE':
        card.note = unescapeValue(p.value).trim();
        break;
      case 'TEL': {
        const number = cleanNumber(p.value);
        // Four digits is the shortest thing worth keeping (an extension);
        // below that it is a parsing accident, not a phone number.
        if (number.replace(/\D/g, '').length >= 4) {
          card.tels.push({ number, params: p.params, group: p.group });
        }
        break;
      }
      case 'X-ABLABEL':
        if (p.group) card.labels[p.group] = unescapeValue(p.value);
        break;
      default:
        break;
    }
  }
  // A file whose last card is missing END:VCARD still yields its contact.
  flush();

  return { contacts, cards, skipped };
}
