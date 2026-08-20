/**
 * Inline SVG icons.
 *
 * Inline rather than an icon font or sprite sheet so every glyph inherits
 * currentColor and scales with the button it sits in — and so the app has no
 * asset loading step at all.
 */

const paths = {
  dialpad:
    '<circle cx="5" cy="5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="19" cy="5" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/><circle cx="5" cy="19" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="19" cy="19" r="1.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 1.9"/>',
  users:
    '<path d="M16 20v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.4"/><path d="M22 20v-1.6a4 4 0 0 0-3-3.87"/><path d="M16.5 3.6a4 4 0 0 1 0 7.75"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  phone:
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  phoneOff:
    '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="M2 2l20 20"/>',
  incoming: '<path d="M18 6 8.5 15.5"/><path d="M15 16H8v-7"/>',
  outgoing: '<path d="M6 18 15.5 8.5"/><path d="M9 8h7v7"/>',
  missed: '<path d="M18 6 8.5 15.5"/><path d="M15 16H8v-7"/>',
  backspace:
    '<path d="M21 5H9.4a2 2 0 0 0-1.5.7L2.6 11.3a1 1 0 0 0 0 1.4l5.3 5.6a2 2 0 0 0 1.5.7H21a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="M17 9.5 12 15M12 9.5l5 5.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.7-4.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash:
    '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-.8 13.1A2 2 0 0 1 16.2 21H7.8a2 2 0 0 1-2-1.9L5 6"/><path d="M10 11v6M14 11v6"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10.5a7 7 0 0 1-14 0"/><path d="M12 17.5V21"/>',
  micOff:
    '<path d="M9 9v1a3 3 0 0 0 5.12 2.12M15 10.4V5a3 3 0 0 0-5.9-.8"/><path d="M19 10.5a7 7 0 0 1-1.2 3.9M5 10.5a7 7 0 0 0 10.4 6.1"/><path d="M12 17.5V21"/><path d="M2 2l20 20"/>',
  pause: '<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>',
  play: '<path d="M7 4.8v14.4l12-7.2z"/>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M17.9 17.9A10.6 10.6 0 0 1 12 19c-6.4 0-10-7-10-7a19 19 0 0 1 5.1-5.9m3.2-1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a19 19 0 0 1-2.3 3.3"/><path d="M9.9 9.9a3 3 0 1 0 4.2 4.2"/><path d="M2 2l20 20"/>',
  link: '<path d="M9.5 14.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14.5 9.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  shield: '<path d="M12 3l7.5 3v5.4c0 4.5-3.1 8.2-7.5 9.6-4.4-1.4-7.5-5.1-7.5-9.6V6z"/><path d="M9.2 12.2l2 2 3.6-4"/>',
};

/**
 * @param {keyof typeof paths} name
 * @param {number} size
 * @param {number} [stroke]
 */
export function icon(name, size = 18, stroke = 1.9) {
  const d = paths[name] || '';
  // Dialpad dots are filled circles; everything else is a stroked outline.
  const fill = name === 'dialpad' || name === 'play' || name === 'pause' ? 'currentColor' : 'none';
  const strokeAttr = fill === 'currentColor' ? 'none' : 'currentColor';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${strokeAttr}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

/** A missed call is a filled-red variant of the incoming arrow. */
export function callDirIcon(dir, size = 15) {
  if (dir === 'missed') return icon('missed', size, 2.2);
  return icon(dir === 'in' ? 'incoming' : 'outgoing', size, 2.2);
}
