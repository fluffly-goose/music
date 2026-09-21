/** Inline SVG icons. Inline so they inherit currentColor and cost no request. */

const wrap = (path: string, size = 24, filled = true) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" ` +
  `fill="${filled ? 'currentColor' : 'none'}" ` +
  `${filled ? '' : 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}>` +
  `${path}</svg>`;

export const icons = {
  play: (s = 24) => wrap('<path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z"/>', s),
  pause: (s = 24) => wrap('<rect x="6" y="4.5" width="4" height="15" rx="1.3"/><rect x="14" y="4.5" width="4" height="15" rx="1.3"/>', s),
  next: (s = 24) => wrap('<path d="M5 5.6v12.8a1 1 0 0 0 1.53.85l9.2-6.4a1 1 0 0 0 0-1.7l-9.2-6.4A1 1 0 0 0 5 5.6Z"/><rect x="17.2" y="5" width="2.4" height="14" rx="1.2"/>', s),
  previous: (s = 24) => wrap('<path d="M19 5.6v12.8a1 1 0 0 1-1.53.85l-9.2-6.4a1 1 0 0 1 0-1.7l9.2-6.4A1 1 0 0 1 19 5.6Z"/><rect x="4.4" y="5" width="2.4" height="14" rx="1.2"/>', s),
  shuffle: (s = 24) => wrap('<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>', s, false),
  repeat: (s = 24) => wrap('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>', s, false),
  repeatOne: (s = 24) => wrap('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/><path d="M11 10h1v5"/>', s, false),
  home: (s = 24) => wrap('<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z"/>', s, false),
  library: (s = 24) => wrap('<path d="M4 4v16"/><path d="M9 4v16"/><path d="m14.5 4.6 4.6 15.2"/>', s, false),
  search: (s = 24) => wrap('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>', s, false),
  settings: (s = 24) => wrap('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z"/>', s, false),
  chevronDown: (s = 24) => wrap('<path d="m6 9 6 6 6-6"/>', s, false),
  chevronRight: (s = 24) => wrap('<path d="m9 6 6 6-6 6"/>', s, false),
  back: (s = 24) => wrap('<path d="m15 18-6-6 6-6"/>', s, false),
  queue: (s = 24) => wrap('<path d="M3 6h13"/><path d="M3 12h13"/><path d="M3 18h9"/><circle cx="18" cy="16" r="3"/><path d="M21 16V7l-3 1"/>', s, false),
  more: (s = 24) => wrap('<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>', s),
  plus: (s = 24) => wrap('<path d="M12 5v14"/><path d="M5 12h14"/>', s, false),
  close: (s = 24) => wrap('<path d="m18 6-12 12"/><path d="m6 6 12 12"/>', s, false),
  volume: (s = 24) => wrap('<path d="M11 5 6.5 9H3v6h3.5L11 19Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>', s, false),
  volumeOff: (s = 24) => wrap('<path d="M11 5 6.5 9H3v6h3.5L11 19Z"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/>', s, false),
  trash: (s = 24) => wrap('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', s, false),
  drag: (s = 24) => wrap('<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>', s),
  music: (s = 24) => wrap('<circle cx="7" cy="18" r="3"/><circle cx="18" cy="15" r="3"/><path d="M10 18V5l11-2v12"/>', s, false),
  warning: (s = 24) => wrap('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>', s, false),
  check: (s = 24) => wrap('<path d="m4 12 5 5L20 6"/>', s, false),
  link: (s = 24) => wrap('<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19.5"/>', s, false),
} as const;

export type IconName = keyof typeof icons;
