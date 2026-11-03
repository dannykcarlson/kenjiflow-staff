// Bot avatars: soft, glossy characters drawn as SVG so every colour is editable
// and there is no background. A bot's avatar is { variant, body, eye, accent, eyeStyle? }.

export const BODY_COLORS = [
  { name: 'Snow', hex: '#F4F7FB' },
  { name: 'Sky', hex: '#7DB4FF' },
  { name: 'Blue', hex: '#2563EB' },
  { name: 'Navy', hex: '#1B2A44' },
  { name: 'Cyan', hex: '#22D3EE' },
  { name: 'Mint', hex: '#34D399' },
  { name: 'Violet', hex: '#8B5CF6' },
  { name: 'Amber', hex: '#F59E0B' },
  { name: 'Coral', hex: '#FB7185' },
  { name: 'Graphite', hex: '#475569' },
];

export const EYE_COLORS = [
  { name: 'Cyan', hex: '#22D3EE' },
  { name: 'White', hex: '#FFFFFF' },
  { name: 'Blue', hex: '#2563EB' },
  { name: 'Navy', hex: '#0B1220' },
  { name: 'Mint', hex: '#34D399' },
  { name: 'Amber', hex: '#FBBF24' },
];

export const EYE_STYLES = ['arcs', 'pills', 'wide', 'dots', 'sleepy', 'wink', 'visor'];

// Each variant: a body path (120×120 box), where the eyes sit, the default eye style and accent.
export const VARIANTS = {
  bean: {
    label: 'Bean', eyeStyle: 'arcs', accent: 'sparkle', tilt: -16, eyes: [47, 72, 52],
    path: rrect(36, 18, 48, 82, 24),
  },
  pebble: {
    label: 'Pebble', eyeStyle: 'pills', accent: 'halo', eyes: [48, 72, 60],
    path: 'M60 30C83 30 95 50 96 69C97 88 81 100 60 100C39 100 23 88 24 69C25 50 37 30 60 30Z',
  },
  cube: {
    label: 'Cube', eyeStyle: 'wide', accent: 'line', eyes: [46, 74, 56],
    path: rrect(24, 26, 72, 70, 26),
  },
  dome: {
    label: 'Dome', eyeStyle: 'sleepy', accent: 'none', eyes: [46, 74, 64],
    path: 'M22 90C20 58 36 30 60 30C84 30 100 58 98 90C98 95 94 98 89 98L31 98C26 98 22 95 22 90Z',
  },
  drop: {
    label: 'Drop', eyeStyle: 'dots', accent: 'sparkle', eyes: [49, 71, 70],
    path: 'M60 16C72 34 93 51 93 72C93 90 79 102 60 102C41 102 27 90 27 72C27 51 48 34 60 16Z',
  },
  capsule: {
    label: 'Capsule', eyeStyle: 'visor', accent: 'none', eyes: [50, 70, 48],
    path: rrect(34, 14, 52, 88, 26),
  },
  orb: {
    label: 'Orb', eyeStyle: 'wink', accent: 'orbit', eyes: [47, 73, 58],
    path: 'M60 26A35 35 0 1 1 59.99 26Z',
  },
  cloud: {
    label: 'Cloud', eyeStyle: 'arcs', accent: 'dots', eyes: [47, 73, 66],
    path: 'M34 96C20 96 13 85 17 74C11 62 21 48 35 50C37 35 53 26 66 33C79 25 97 35 94 51C106 55 109 71 100 79C104 91 94 98 84 96Z',
  },
  mochi: {
    label: 'Mochi', eyeStyle: 'dots', accent: 'blush', eyes: [46, 74, 68],
    path: 'M16 80C16 55 36 40 60 40C84 40 104 55 104 80C104 95 89 101 60 101C31 101 16 95 16 80Z',
  },
  pod: {
    label: 'Pod', eyeStyle: 'pills', accent: 'spark2', eyes: [47, 73, 52],
    path: 'M20 50C20 33 37 22 60 22C83 22 100 33 100 50C100 77 81 101 60 101C39 101 20 77 20 50Z',
  },
  leaf: {
    label: 'Leaf', eyeStyle: 'arcs', accent: 'sparkle', eyes: [46, 72, 60],
    path: 'M62 18C89 28 99 55 93 78C87 96 71 103 56 101C35 97 23 80 27 59C31 39 45 25 62 18Z',
  },
  bubble: {
    label: 'Bubble', eyeStyle: 'pills', accent: 'dots', eyes: [48, 72, 56],
    path: 'M60 20C83 20 99 36 99 57C99 78 83 93 60 93C55 93 50 92 46 91L30 100L33 85C25 78 21 68 21 57C21 36 37 20 60 20Z',
  },
};

export const DEFAULT_AVATAR = { variant: 'bean', body: '#F4F7FB', eye: '#22D3EE', accent: '#22D3EE' };

let uid = 0;

export function avatarSVG(avatar = {}, size = 36) {
  const a = { ...DEFAULT_AVATAR, ...avatar };
  const v = VARIANTS[a.variant] || VARIANTS.bean;
  const eyeStyle = a.eyeStyle || v.eyeStyle;
  const id = `kfa${++uid}`;
  const body = a.body;
  const dark = luminance(body) < 0.35;
  const [lx, rx, ey] = v.eyes;
  const tilt = v.tilt ? ` transform="rotate(${v.tilt} 60 60)"` : '';

  return `<svg class="bot-avatar" width="${size}" height="${size}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
<defs>
  <radialGradient id="${id}b" cx="36%" cy="26%" r="82%">
    <stop offset="0%" stop-color="${mix(body, '#FFFFFF', dark ? 0.35 : 0.7)}"/>
    <stop offset="48%" stop-color="${body}"/>
    <stop offset="100%" stop-color="${mix(body, '#0B1220', dark ? 0.35 : 0.22)}"/>
  </radialGradient>
  <linearGradient id="${id}r" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="${dark ? 0.28 : 0.6}"/>
    <stop offset="55%" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <filter id="${id}g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.2"/></filter>
  <filter id="${id}s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter>
</defs>
<ellipse cx="60" cy="108" rx="30" ry="5" fill="#0B1220" opacity="0.16" filter="url(#${id}s)"/>
<g${tilt}>
  <path d="${v.path}" fill="url(#${id}b)"/>
  <path d="${v.path}" fill="url(#${id}r)"/>
  ${shine(v, id)}
  ${eyeStyle === 'visor' ? visor(lx, rx, ey, body) : ''}
  ${eyesMarkup(eyeStyle, lx, rx, ey, a.eye, id)}
  ${accentInside(v.accent, lx, rx, ey, a.accent)}
</g>
${accentOutside(v.accent, a.accent, id)}
</svg>`;
}

function shine(v, id) {
  // Soft specular highlight near the top-left of the body.
  const [lx, , ey] = v.eyes;
  const top = Math.max(18, ey - 30);
  return `<ellipse cx="${lx - 4}" cy="${top + 4}" rx="11" ry="6" fill="#FFFFFF" opacity="0.55" filter="url(#${id}g)" transform="rotate(-24 ${lx - 4} ${top + 4})"/>`;
}

function eyesMarkup(style, lx, rx, ey, color, id) {
  const shape = (x, kind = style) => {
    switch (kind) {
      case 'arcs': return `<path d="M${x - 6} ${ey + 3}Q${x} ${ey - 6} ${x + 6} ${ey + 3}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`;
      case 'sleepy': return `<path d="M${x - 7} ${ey}Q${x} ${ey + 5} ${x + 7} ${ey}" fill="none" stroke="${color}" stroke-width="4.6" stroke-linecap="round"/>`;
      case 'wide': return `<rect x="${x - 7.5}" y="${ey - 4.5}" width="15" height="9" rx="4.5" fill="${color}"/>`;
      case 'dots': return `<circle cx="${x}" cy="${ey}" r="5" fill="${color}"/>`;
      case 'visor':
      case 'pills':
      default: return `<rect x="${x - 4}" y="${ey - 7}" width="8" height="14" rx="4" fill="${color}"/>`;
    }
  };
  const pair = style === 'wink'
    ? shape(lx, 'arcs') + shape(rx, 'dots')
    : shape(lx) + shape(rx);
  // Draw twice: a blurred copy gives the glow, the crisp copy sits on top.
  return `<g opacity="0.85" filter="url(#${id}g)">${pair}</g>${pair}`;
}

function visor(lx, rx, ey, body) {
  const w = rx - lx + 26;
  return `<rect x="${lx - 13}" y="${ey - 11}" width="${w}" height="22" rx="11" fill="${mix(body, '#0B1220', 0.55)}"/>`;
}

function accentInside(kind, lx, rx, ey, color) {
  const cx = (lx + rx) / 2;
  if (kind === 'line') {
    return `<rect x="${cx - 16}" y="${ey + 11}" width="32" height="2.4" rx="1.2" fill="${color}" opacity="0.9"/>`;
  }
  if (kind === 'blush') {
    return `<ellipse cx="${lx - 6}" cy="${ey + 10}" rx="6" ry="3.4" fill="${color}" opacity="0.35"/><ellipse cx="${rx + 6}" cy="${ey + 10}" rx="6" ry="3.4" fill="${color}" opacity="0.35"/>`;
  }
  return '';
}

function accentOutside(kind, color, id) {
  const glow = (svg) => `<g filter="url(#${id}g)" opacity="0.9">${svg}</g>${svg}`;
  switch (kind) {
    case 'sparkle': return glow(star(98, 26, 9, color));
    case 'spark2': return glow(star(100, 22, 7, color) + star(88, 12, 4, color));
    case 'halo': return glow(`<ellipse cx="60" cy="16" rx="22" ry="5.5" fill="none" stroke="${color}" stroke-width="3.4"/>`);
    case 'orbit': return `<ellipse cx="60" cy="61" rx="50" ry="12" fill="none" stroke="${color}" stroke-width="2.6" opacity="0.75" transform="rotate(-18 60 61)"/>${glow(`<circle cx="104" cy="44" r="3.6" fill="${color}"/>`)}`;
    case 'dots': return glow(`<circle cx="94" cy="20" r="3.4" fill="${color}"/><circle cx="103" cy="14" r="2.4" fill="${color}" opacity="0.8"/><circle cx="109" cy="8" r="1.6" fill="${color}" opacity="0.6"/>`);
    default: return '';
  }
}

function star(cx, cy, r, color) {
  const k = r * 0.28;
  return `<path d="M${cx} ${cy - r}Q${cx + k} ${cy - k} ${cx + r} ${cy}Q${cx + k} ${cy + k} ${cx} ${cy + r}Q${cx - k} ${cy + k} ${cx - r} ${cy}Q${cx - k} ${cy - k} ${cx} ${cy - r}Z" fill="${color}"/>`;
}

function rrect(x, y, w, h, r) {
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isHexColor(value) {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}
