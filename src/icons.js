// Local stroke icons share a 24px grid so navigation and controls align.
const lines = {
  radar:
    '<path d="M20.3 8.5a9 9 0 1 1-4.8-4.8M16.7 9.7a5.2 5.2 0 1 1-3.1-2.9M12 12l8.5-8.5"/><circle cx="12" cy="12" r="1.25" fill="currentColor"/>',
  edit: '<path d="m15 5 4 4M4 20l4.6-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20Z"/>',
  compose:
    '<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6M14.5 5.5l4 4m-9 5 .5-4L17 3.5a2.8 2.8 0 0 1 4 4L14 14.5l-4 .5Z"/>',
  queue: '<rect x="3" y="4" width="18" height="5" rx="1.6"/><path d="M5 13h14M6.5 17h11M9 21h6"/>',
  channels:
    '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><path d="M10 6.5h3.5a4 4 0 0 1 4 4V14M6.5 10v4.5a3 3 0 0 0 3 3H14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  external: '<path d="M7 17 17 7M7 7h10v10"/>',
  send: '<path d="m21 3-6.5 18-4-7.5L3 9.5 21 3ZM10.5 13.5 21 3"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  check: '<path d="m4 13 5 5L20 6"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  'chevron-down': '<path d="m7 10 5 5 5-5"/>',
  link: '<path d="m9.4 14.6 5.2-5.2m-4.5-2.7 2.3-2.3a5 5 0 0 1 7.1 7.1l-2.4 2.3m-3.2 3.4-2.3 2.3a5 5 0 0 1-7.1-7.1l2.4-2.3"/>',
  chart: '<path d="M3 16 8 11l4 3 8-9m-5 0h5v5"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  'bar-chart': '<path d="M5 19v-6m7 6V5m7 14V9"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-9h.01"/>',
  filter: '<path d="M3 6h18M6 12h12m-9 6h6"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 8a7 7 0 0 1 12-2l2.5 3M4 15l2.5 3a7 7 0 0 0 12-2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  hash: '<path d="M5 9h15M4 15h15M11 4 8 20M17 4l-3 16"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.7l6.2-.9L12 3Z"/>',
  github:
    '<path fill="currentColor" stroke="none" d="M12 .9a11.1 11.1 0 0 0-3.5 21.65c.55.1.76-.24.76-.54v-2.14c-3.1.67-3.75-1.32-3.75-1.32-.5-1.29-1.23-1.63-1.23-1.63-.99-.68.08-.67.08-.67 1.1.08 1.68 1.13 1.68 1.13.98 1.68 2.57 1.2 3.2.93.1-.71.38-1.2.7-1.47-2.48-.28-5.08-1.24-5.08-5.52 0-1.22.43-2.22 1.14-3-.11-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.14a10.7 10.7 0 0 1 5.56 0c2.12-1.44 3.04-1.14 3.04-1.14.61 1.54.23 2.68.12 2.96.71.78 1.14 1.78 1.14 3.01 0 4.28-2.61 5.23-5.1 5.51.4.35.76 1.01.76 2.05v3.12c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/>',
};
export function icons(name, size = 20) {
  return (
    '<svg aria-hidden="true" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    (lines[name] || lines.layers) +
    '</svg>'
  );
}
