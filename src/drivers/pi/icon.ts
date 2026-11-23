// The Pi driver's icon: a plain π glyph drawn for ARI (not Pi's own logo).

import type { Icon } from "../../generated/common.ts";

export const PI_ICON: Icon = {
  type: "svg",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#111827" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"/><path d="M9 7v11"/><path d="M15 7v9a2 2 0 0 0 3 1.7"/></svg>',
  darkSvg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#f9fafb" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"/><path d="M9 7v11"/><path d="M15 7v9a2 2 0 0 0 3 1.7"/></svg>',
};
