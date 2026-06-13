/*  Parametric Electronics Enclosure
 *  ================================
 *  Two-part project box: base with corner screw posts + lid with a
 *  registration lip, ventilation slots and a cable notch.
 *  All dimensions in mm. Tune the parameters, re-render, iterate.
 */

/* [Part selection] */
part = "both";          // ["base", "lid", "both"]

/* [Inner cavity — what your PCB needs] */
inner_l = 60;           // inner length (X)
inner_w = 40;           // inner width  (Y)
inner_h = 22;           // inner height (Z, floor to underside of lid)

/* [Shell] */
wall     = 2.4;         // side wall thickness
floor_th = 2.0;         // base floor thickness
corner_r = 3.0;         // outer corner radius

/* [Lid] */
lid_th    = 2.2;        // lid plate thickness
lip_h     = 3.0;        // registration lip depth into the base
lip_clear = 0.25;       // lip-to-wall clearance (tune for your printer)

/* [Screw posts] */
post_d  = 7.0;          // post outer diameter
screw_d = 2.2;          // pilot hole (M2.5 self-tapping screw)
hole_d  = 2.8;          // screw clearance hole in the lid

/* [Lid vents] */
vents      = true;
vent_l     = 24;        // slot length (X)
vent_w     = 2.0;       // slot width  (Y)
vent_pitch = 5.0;       // center-to-center slot spacing
vent_n     = 5;         // number of slots

/* [Cable notch] */
notch_w = 8;            // notch width along the +X wall
notch_h = 5;            // notch depth measured down from the top edge

$fn = 48;

/* ---------- derived values ---------- */
outer_l    = inner_l + 2 * wall;
outer_w    = inner_w + 2 * wall;
base_h     = inner_h + floor_th;
post_off_x = inner_l / 2 - post_d / 2;
post_off_y = inner_w / 2 - post_d / 2;

/* ---------- helpers ---------- */

// Centered 2D rectangle with rounded corners.
module rrect(l, w, r) {
    offset(r = r) offset(delta = -r) square([l, w], center = true);
}

// Repeat children at the four screw-post centers.
module at_posts() {
    for (x = [-post_off_x, post_off_x], y = [-post_off_y, post_off_y])
        translate([x, y, 0]) children();
}

/* ---------- base ---------- */
module base() {
    // shell
    difference() {
        linear_extrude(base_h) rrect(outer_l, outer_w, corner_r);
        translate([0, 0, floor_th])
            linear_extrude(base_h)   // overshoots the top — intentional
                rrect(inner_l, inner_w, max(corner_r - wall, 0.5));
        // cable notch in the +X wall, open at the top edge
        translate([outer_l / 2, 0, base_h - notch_h / 2])
            cube([3 * wall, notch_w, notch_h + 1], center = true);
    }
    // screw posts with pilot holes
    at_posts() difference() {
        translate([0, 0, floor_th]) cylinder(d = post_d, h = inner_h);
        translate([0, 0, floor_th]) cylinder(d = screw_d, h = inner_h + 1);
    }
}

/* ---------- lid (printed as oriented: plate down, lip up) ---------- */
module lid() {
    difference() {
        union() {
            // top plate
            linear_extrude(lid_th) rrect(outer_l, outer_w, corner_r);
            // registration lip that drops inside the base walls
            translate([0, 0, lid_th]) linear_extrude(lip_h) difference() {
                rrect(inner_l - 2 * lip_clear, inner_w - 2 * lip_clear,
                      max(corner_r - wall, 0.5));
                rrect(inner_l - 2 * lip_clear - 2 * wall,
                      inner_w - 2 * lip_clear - 2 * wall,
                      max(corner_r - 2 * wall, 0.5));
            }
        }
        // clear the lip where it would collide with the screw posts
        at_posts()
            translate([0, 0, lid_th - 0.5])
                cylinder(d = post_d + 2 * lip_clear, h = lip_h + 1);
        // screw clearance holes through the plate
        at_posts()
            translate([0, 0, -0.5]) cylinder(d = hole_d, h = lid_th + 1);
        // ventilation slots
        if (vents)
            for (i = [0 : vent_n - 1])
                translate([0, (i - (vent_n - 1) / 2) * vent_pitch, -0.5])
                    linear_extrude(lid_th + 1)
                        rrect(vent_l, vent_w, vent_w / 2 - 0.01);
    }
}

/* ---------- layout ---------- */
if (part == "base" || part == "both") base();
if (part == "lid" || part == "both")
    translate([0, outer_w + 12, 0]) lid();
