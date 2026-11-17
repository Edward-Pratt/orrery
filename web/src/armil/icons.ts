// Armil's icons for ng-icons: the inner markup of each from armil/icons/icons.json, in its wrapper (24 grid,
// 1.5 stroke, currentColor). Register them with `provideIcons({ arPlus, ... })` and draw with
// `<ng-icon name="arPlus" />`. Only the icons orrery uses; add one by copying its entry from icons.json.

const svg = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-miterlimit="10">${inner}</svg>`;

export const arAlert = svg('<path d="M12 4l9 15.5H3zM12 10v4.5"/><circle cx="12" cy="16.9" r="1.1" fill="currentColor" stroke="none"/>');
export const arArrowLeft = svg('<g transform="rotate(180 12 12)"><path d="M4 12h15.5M13.5 6l6 6-6 6"/></g>');
export const arCheck = svg('<path d="M4.5 12.5l5 5 10-11"/>');
export const arChevronRight = svg('<path d="M9 5l7 7-7 7"/>');
export const arCircleAlert = svg('<circle cx="12" cy="12" r="8.25"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.25" r="1.1" fill="currentColor" stroke="none"/>');
export const arCircleCheck = svg('<circle cx="12" cy="12" r="8.25"/><path d="M8 12.5l3 3 5.5-6.5"/>');
export const arClose = svg('<path d="M5.5 5.5l13 13M18.5 5.5l-13 13"/>');
export const arCoffee = svg('<path d="M5 9.5h11.5V15a4.5 4.5 0 0 1-4.5 4.5H9.5A4.5 4.5 0 0 1 5 15zM16.5 11h1.25a2.5 2.5 0 0 1 0 5H16.5M8 3.5v3M12 3.5v3"/>');
export const arCopy = svg('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1"/><path d="M15.5 8.5v-4h-11v11h4"/>');
export const arCpu = svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1"/><rect x="10" y="10" width="4" height="4"/><path d="M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"/>');
export const arExternal = svg('<path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5M10 6.5H4.5v13h13V14"/>');
export const arFileUp = svg('<path d="M6 3.5h8l4.5 4.5v12.5H6zM13.5 3.5v5h5M12 17.5v-6M9.25 14L12 11.25 14.75 14"/>');
export const arInfo = svg('<circle cx="12" cy="12" r="8.25"/><path d="M12 11v6"/><circle cx="12" cy="7.75" r="1.1" fill="currentColor" stroke="none"/>');
export const arLayers = svg('<path d="M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>');
export const arLibrary = svg('<path d="M5 4v16M9.5 4v16M14 6.5l4.5 13.5M3.5 20h17"/>');
export const arLock = svg('<rect x="5" y="10.5" width="14" height="9.5" rx="1"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15.25" r="1.25" fill="currentColor" stroke="none"/>');
export const arLogs = svg('<path d="M4.5 5.5h15M4.5 10h9M4.5 14.5h15M4.5 19h6"/>');
export const arMonitor = svg('<rect x="3.5" y="4.5" width="17" height="11.5" rx="1"/><path d="M8.5 20h7M12 16v4"/>');
export const arMoon = svg('<path d="M19.5 14.5a8 8 0 0 1-10-10 8 8 0 1 0 10 10z"/>');
export const arMore = svg('<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>');
export const arOctagonX = svg('<path d="M8.5 3.75h7l4.75 4.75v7l-4.75 4.75h-7L3.75 15.5v-7zM9 9l6 6M15 9l-6 6"/>');
export const arPackage = svg('<path d="M12 3.5L20 8v8l-8 4.5L4 16V8zM4 8l8 4.5L20 8M12 12.5v8"/>');
export const arPlus = svg('<path d="M12 4v16M4 12h16"/>');
export const arSearch = svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/>');
export const arServer = svg('<rect x="4" y="4.5" width="16" height="6.5" rx="1"/><rect x="4" y="13" width="16" height="6.5" rx="1"/><circle cx="7.5" cy="7.75" r="1.1" fill="currentColor" stroke="none"/><circle cx="7.5" cy="16.25" r="1.1" fill="currentColor" stroke="none"/><path d="M13.5 7.75H17M13.5 16.25H17"/>');
export const arSun = svg('<circle cx="12" cy="12" r="3.75"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>');
export const arTerminal = svg('<rect x="3.5" y="5" width="17" height="14" rx="1"/><path d="M7 9.5l3 2.5-3 2.5M12.5 14.5h4.5"/>');
export const arUsers = svg('<circle cx="9" cy="8.5" r="3.25"/><path d="M3 20v-.75a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5V20M15.5 5.5a3.25 3.25 0 0 1 0 6M17.5 14.6a5 5 0 0 1 3.5 4.65V20"/>');
