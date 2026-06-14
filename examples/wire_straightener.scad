part = "assembly";
SHOW_HW = true;
$fn = 48;

B_OD = 22; B_ID = 8; B_W = 7; B_R = B_OD/2;
SHAFT_D  = 8; SHAFT_CL = 8.6; HEAD_D = 14; HEAD_T = 4;
CH_W = B_W + 1.2; WALL = 6; BODY_W = CH_W + 2*WALL;
N_BOT = 5; N_TOP = 4; PITCH = 26; OVER = 18;
LEN = (N_BOT-1)*PITCH + B_OD + 2*OVER;
BASE_T = 6; GAP = 3;
Z_BB = BASE_T + GAP + B_R; WIRE_Z = Z_BB + B_R; Z_TB_UP = WIRE_Z + B_R;
TRAVEL = 4; WALL_H = Z_TB_UP + B_R + 6;
CO_T = 5; CO_CL = 0.5; CARR_TOP = Z_TB_UP + B_R + 4; BR_T = 6; ADJ_D = 6.2;
TOP_Z = CARR_TOP + 10;
function bot_x(i) = OVER + B_R + i*PITCH;
function top_x(i) = OVER + B_R + PITCH/2 + i*PITCH;
ADJ_X0 = top_x(0); ADJ_X1 = top_x(N_TOP-1);
module yrod(d,len) rotate([90,0,0]) cylinder(d=d,h=len,center=true);

module body(){
  difference(){
    union(){
      translate([LEN/2,0,BASE_T/2]) cube([LEN,BODY_W,BASE_T],center=true);
      for(s=[-1,1]) translate([LEN/2,s*(CH_W/2+WALL/2),WALL_H/2]) cube([LEN,WALL,WALL_H],center=true);
      for(gx=[OVER/2,LEN-OVER/2]) translate([gx,0,WIRE_Z]) rotate([90,0,0]) cylinder(d=CH_W+2*WALL,h=CH_W,center=true);
      for(ax=[ADJ_X0,ADJ_X1]) translate([ax,0,(WALL_H+TOP_Z)/2]) cube([18,BODY_W,TOP_Z-WALL_H],center=true);
    }
    for(i=[0:N_BOT-1]){
      translate([bot_x(i),0,Z_BB]) yrod(SHAFT_CL,BODY_W+2);
      for(s=[-1,1]) translate([bot_x(i),s*(BODY_W/2-HEAD_T/2+0.01),Z_BB]) yrod(HEAD_D,HEAD_T);
    }
    for(i=[0:N_TOP-1]) hull() for(zz=[Z_TB_UP,Z_TB_UP-TRAVEL]) translate([top_x(i),0,zz]) yrod(SHAFT_CL,BODY_W+2);
    for(gx=[OVER/2,LEN-OVER/2]) translate([gx,0,WIRE_Z]) rotate([0,90,0]) cylinder(d=3.4,h=LEN,center=true);
    translate([-0.01,0,WIRE_Z]) rotate([0,90,0]) cylinder(d1=10,d2=3.4,h=10);
    translate([LEN+0.01,0,WIRE_Z]) rotate([0,-90,0]) cylinder(d1=10,d2=3.4,h=10);
    for(mx=[OVER/2,LEN-OVER/2],my=[-1,1]) translate([mx,my*(BODY_W/2-4),-1]) cylinder(d=4.5,h=BASE_T+2);
    for(ax=[ADJ_X0,ADJ_X1]) translate([ax,0,WALL_H-1]) cylinder(d=ADJ_D,h=TOP_Z);
  }
}
module carriage(){
  py = BODY_W/2 + CO_CL + CO_T/2;
  x0 = top_x(0)-13; x1 = top_x(N_TOP-1)+13; plen = x1-x0;
  difference(){
    union(){
      for(s=[-1,1]) translate([(x0+x1)/2,s*py,(Z_TB_UP-TRAVEL/2)]) cube([plen,CO_T,(B_R+8)+TRAVEL],center=true);
      translate([(x0+x1)/2,0,CARR_TOP-BR_T/2]) cube([plen,BODY_W+2*CO_CL+2*CO_T,BR_T],center=true);
    }
    for(i=[0:N_TOP-1]) translate([top_x(i),0,Z_TB_UP]) yrod(SHAFT_CL,BODY_W+2*CO_T+4);
    for(ax=[ADJ_X0,ADJ_X1]) translate([ax,0,CARR_TOP-BR_T-0.01]) cylinder(d=5.0,h=BR_T+0.2);
  }
}
module knob(){
  difference(){
    union(){ cylinder(d=24,h=12); for(a=[0:30:359]) rotate(a) translate([13,0,0]) cylinder(d=5,h=12); }
    translate([0,0,-0.1]) cylinder(d=6.2,h=12.4);
    translate([0,0,-0.1]) cylinder(d=12,h=4,$fn=6);
  }
}
module bearing() difference(){ yrod(B_OD,B_W); yrod(B_ID,B_W+0.2); }
module hw(){
  color("silver"){
    for(i=[0:N_BOT-1]) translate([bot_x(i),0,Z_BB]) bearing();
    for(i=[0:N_TOP-1]) translate([top_x(i),0,Z_TB_UP]) bearing();
  }
  color("gold"){
    for(i=[0:N_BOT-1]) translate([bot_x(i),0,Z_BB]) yrod(SHAFT_D,BODY_W+8);
    for(i=[0:N_TOP-1]) translate([top_x(i),0,Z_TB_UP]) yrod(SHAFT_D,BODY_W+2*CO_T+8);
  }
  color("red") translate([-10,0,WIRE_Z]) rotate([0,90,0]) cylinder(d=2,h=LEN+20);
}

if(part=="assembly"){
  color("LightSteelBlue") body();
  color("Khaki") carriage();
  for(ax=[ADJ_X0,ADJ_X1]) translate([ax,0,TOP_Z]) color("DimGray") knob();
  if(SHOW_HW) hw();
}else if(part=="body") body();
else if(part=="carriage") carriage();
else if(part=="knob") knob();
