/**
 * OpenSCAD `--camera=tx,ty,tz,rx,ry,rz,dist` presets (rotate-around-origin form).
 * All are used together with `--autocenter --viewall`, so translation is 0 and
 * the distance only seeds the fit-to-view calculation.
 */
export const VIEWS = {
  diagonal: "0,0,0,55,0,25,140",
  front: "0,0,0,90,0,0,140",
  back: "0,0,0,90,0,180,140",
  left: "0,0,0,90,0,90,140",
  right: "0,0,0,90,0,270,140",
  top: "0,0,0,0,0,0,140",
  bottom: "0,0,0,180,0,0,140",
} as const;

export type ViewName = keyof typeof VIEWS;

export const VIEW_NAMES = Object.keys(VIEWS) as [ViewName, ...ViewName[]];
