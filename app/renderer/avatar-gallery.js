import { avatarSVG, VARIANTS } from './avatars.js';

const looks = [
  { body: '#F4F7FB', eye: '#22D3EE', accent: '#22D3EE' },
  { body: '#2563EB', eye: '#22D3EE', accent: '#22D3EE' },
  { body: '#1B2A44', eye: '#FFFFFF', accent: '#22D3EE' },
  { body: '#34D399', eye: '#0B1220', accent: '#FBBF24' },
  { body: '#F59E0B', eye: '#FFFFFF', accent: '#2563EB' },
];

document.getElementById('gal').innerHTML = Object.entries(VARIANTS).map(([variant, v], i) => {
  const look = looks[i % looks.length];
  return `<div class="cell">
    ${avatarSVG({ variant, ...looks[0] }, 120)}
    <div class="row">${looks.slice(1).map((l) => avatarSVG({ variant, ...l }, 44)).join('')}</div>
    <div class="row">${avatarSVG({ variant, ...look }, 34)}${avatarSVG({ variant, ...look }, 24)}${avatarSVG({ variant, ...look }, 18)}</div>
    <strong>${v.label}</strong>
  </div>`;
}).join('');
