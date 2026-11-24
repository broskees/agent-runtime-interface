// The Cursor driver's icon: a plain pointer glyph drawn for ARI (not Cursor's own logo).

import type { Icon } from "../../generated/common.ts";

export const CURSOR_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="2" stroke-linejoin="round"><path d="M5 3l14 8-6 2-3 7z"/></svg>',
  darkSvg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#f9fafb" stroke-width="2" stroke-linejoin="round"><path d="M5 3l14 8-6 2-3 7z"/></svg>',
};
