import { esc, hue, initials } from '../format.js';
import { icon } from '../icons.js';

/**
 * Initials on a colour derived from the name.
 *
 * A number with no contact gets a neutral glyph instead of initials, because
 * "+3" in a coloured circle looks like a person and isn't one.
 */
export function avatar(name, { size = '', seed = '' } = {}) {
  const label = initials(name);
  if (!label) {
    return `<div class="avatar unknown ${size}">${icon('user', size === 'lg' ? 34 : size === 'xl' ? 48 : 17)}</div>`;
  }
  return `<div class="avatar ${size}" style="--h:${hue(seed || name)}">${esc(label)}</div>`;
}
